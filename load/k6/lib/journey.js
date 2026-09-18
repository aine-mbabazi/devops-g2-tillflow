import http from 'k6/http';
import { check } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import { signServiceAuth } from './auth.js';

// Per-step latency, separate from the global http_req_duration, so the
// capacity model can name which step is the bottleneck rather than reporting
// one blended number.
export const saleCreateDuration = new Trend('tillflow_sale_create_duration', true);
export const salePayDuration = new Trend('tillflow_sale_pay_duration', true);
export const tenantConfigDuration = new Trend('tillflow_tenant_config_duration', true);

// Money-correctness counters. A load test that only measures latency would
// miss the failure that actually matters here: a duplicate charge under
// concurrency. Every /pay is retried once with the same sale, and a second
// dispatch is counted as an invariant breach.
export const duplicateDispatch = new Counter('tillflow_duplicate_dispatch');

export const POS_BASE_URL = __ENV.POS_BASE_URL || 'http://127.0.0.1:3002';
export const SERVICE_AUTH_SECRET = __ENV.SERVICE_AUTH_SECRET || 'local-load-secret';
export const TENANT_ID = __ENV.TENANT_ID || 'load-tenant';

// The brief's envelope: failed requests < 1%, p95 < 500 ms, checks > 99%.
// POS's own SLO is stricter (p95 < 400 ms), so the POS-specific step carries
// the tighter threshold and the blended figure carries the brief's.
export const SHARED_THRESHOLDS = {
  http_req_failed: ['rate<0.01'],
  http_req_duration: ['p(95)<500'],
  checks: ['rate>0.99'],
  tillflow_sale_create_duration: ['p(95)<400'],
  tillflow_duplicate_dispatch: ['count==0'],
};

function authHeaders(extra = {}) {
  return {
    'Content-Type': 'application/json',
    'X-Service-Auth': signServiceAuth(TENANT_ID, SERVICE_AUTH_SECRET),
    ...extra,
  };
}

export function configureTenant() {
  const body = JSON.stringify({
    attendants: [
      { attendant_id: 'a1', phone: '+254700000001' },
      { attendant_id: 'a2', phone: '+254700000002' },
    ],
    commission_rate_basis_points: 250,
  });
  const res = http.put(`${POS_BASE_URL}/tenants/${TENANT_ID}/config`, body, {
    headers: authHeaders(),
    tags: { step: 'tenant_config_write' },
  });
  check(res, { 'tenant configured': (r) => r.status === 200 });
  return res.status === 200;
}

// The read-heavy step. This is the cache-aside candidate, so the capacity
// model reports it before and after ElastiCache lands.
export function readTenantConfig() {
  const res = http.get(`${POS_BASE_URL}/tenants/${TENANT_ID}/config`, {
    headers: authHeaders(),
    tags: { step: 'tenant_config_read' },
  });
  tenantConfigDuration.add(res.timings.duration);
  check(res, { 'tenant config read 200': (r) => r.status === 200 });
}

// One attendant recording one sale and taking payment for it — the journey
// the POS SLI is written against.
export function recordAndPaySale() {
  const idempotencyKey = `k6-${__VU}-${__ITER}-${Date.now()}`;
  const saleBody = JSON.stringify({
    tenant_id: TENANT_ID,
    attendant_id: __VU % 2 === 0 ? 'a1' : 'a2',
    line_items: [
      { description: 'maize flour 2kg', quantity: 2, unit_price_minor: 18000 },
      { description: 'cooking oil 1l', quantity: 1, unit_price_minor: 32000 },
    ],
    currency: 'KES',
    customer_phone: '+254700000009',
  });

  const created = http.post(`${POS_BASE_URL}/sales`, saleBody, {
    headers: authHeaders({ 'Idempotency-Key': idempotencyKey }),
    tags: { step: 'sale_create' },
  });
  saleCreateDuration.add(created.timings.duration);
  const createdOk = check(created, {
    'sale created 201': (r) => r.status === 201,
    'sale has id': (r) => !!(r.json() || {}).sale_id,
  });
  if (!createdOk) return;

  const saleId = created.json().sale_id;

  const paid = http.post(`${POS_BASE_URL}/sales/${saleId}/pay`, null, {
    headers: authHeaders(),
    tags: { step: 'sale_pay' },
  });
  salePayDuration.add(paid.timings.duration);
  check(paid, { 'pay accepted 202': (r) => r.status === 202 });
  if (paid.status !== 202) return;

  // Idempotency under load. POS answers 202 only on the call that actually
  // dispatched an STK push; once a payment is attached to the sale it answers
  // 200 without touching Payments (services/pos/src/app.js — the `sale.paymentId`
  // branch). So a second 202 for the same sale is a second dispatch: a money
  // bug, not a performance one, and it fails the run through its own threshold
  // rather than being averaged away in the latency percentiles.
  const retried = http.post(`${POS_BASE_URL}/sales/${saleId}/pay`, null, {
    headers: authHeaders(),
    tags: { step: 'sale_pay_retry' },
  });
  const noSecondDispatch = retried.status === 200;
  check(retried, { 'retry is a no-op 200, not a second dispatch': () => noSecondDispatch });
  if (retried.status === 202) duplicateDispatch.add(1);
}

// k6's default text summary plus a machine-readable export. The brief asks for
// "k6 JSON + analysis", and the JSON is what the capacity model cites.
export function summaryHandler(name) {
  return function handleSummary(data) {
    const out = {};
    out[`evidence/reliability-operations/k6/${name}.json`] = JSON.stringify(data, null, 2);
    out.stdout = textSummaryFallback(data);
    return out;
  };
}

function textSummaryFallback(data) {
  const m = data.metrics || {};
  const line = (label, metric, field) => {
    const value = m[metric] && m[metric].values ? m[metric].values[field] : undefined;
    return `  ${label.padEnd(34)} ${value === undefined ? 'n/a' : Number(value).toFixed(2)}\n`;
  };
  return [
    '\n',
    line('http_reqs (total)', 'http_reqs', 'count'),
    line('http_reqs/s', 'http_reqs', 'rate'),
    line('http_req_failed (rate)', 'http_req_failed', 'rate'),
    line('http_req_duration p95 (ms)', 'http_req_duration', 'p(95)'),
    line('http_req_duration p99 (ms)', 'http_req_duration', 'p(99)'),
    line('sale_create p95 (ms)', 'tillflow_sale_create_duration', 'p(95)'),
    line('sale_pay p95 (ms)', 'tillflow_sale_pay_duration', 'p(95)'),
    line('tenant_config p95 (ms)', 'tillflow_tenant_config_duration', 'p(95)'),
    line('checks (rate)', 'checks', 'rate'),
    line('duplicate dispatches', 'tillflow_duplicate_dispatch', 'count'),
    '\n',
  ].join('');
}
