import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { InMemorySaleStore } from '../src/sale-store.js';
import { PaymentsClient } from '../src/payments-client.js';
import { signServiceAuth } from '../../_shared/service-auth.js';

// This integration test drives POS against a real Payments HTTP server
// (backed by the deterministic fake Daraja adapter) so the full
// sale -> STK -> callback -> reconcile -> paid flow is proven end to end,
// per the brief's "Sale -> M-Pesa payment -> paid" G2 requirement.
import { createApp as createPaymentsApp } from '../../payments/src/app.js';
import { FakeDarajaClient } from '../../payments/src/daraja/fake-client.js';

const TEST_SECRET = 'test-service-auth-secret';
function authHeader(tenantId) {
  return { 'x-service-auth': signServiceAuth(tenantId, TEST_SECRET) };
}

test('configuration requires a service auth secret and validates URLs and POS_STORE', () => {
  assert.throws(() => loadConfig({}), /SERVICE_AUTH_SECRET/);
  assert.deepEqual(loadConfig({ SERVICE_AUTH_SECRET: TEST_SECRET }), {
    host: '127.0.0.1', port: 3002, paymentsBaseUrl: 'http://127.0.0.1:3001',
    serviceAuthSecret: TEST_SECRET, posStore: 'memory', databaseUrl: undefined,
  });
  assert.throws(() => loadConfig({ SERVICE_AUTH_SECRET: TEST_SECRET, PAYMENTS_BASE_URL: 'not-a-url' }), /PAYMENTS_BASE_URL/);
  assert.throws(() => loadConfig({ SERVICE_AUTH_SECRET: TEST_SECRET, POS_STORE: 'postgres' }), /DATABASE_URL/);
  assert.throws(() => loadConfig({ SERVICE_AUTH_SECRET: TEST_SECRET, POS_STORE: 'bogus' }), /POS_STORE/);
});

async function startPaymentsServer(t) {
  const client = new FakeDarajaClient();
  let lastProviderRequestId;
  const initiate = client.initiateStkPush.bind(client);
  client.initiateStkPush = async (input) => {
    const result = await initiate(input);
    lastProviderRequestId = result.providerRequestId;
    return result;
  };
  const server = createPaymentsApp({ darajaClient: client, serviceAuthSecret: TEST_SECRET });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, client, getLastProviderRequestId: () => lastProviderRequestId };
}

function postDarajaCallback(paymentsBaseUrl, checkoutRequestId) {
  return fetch(`${paymentsBaseUrl}/payments/callbacks/daraja`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ Body: { stkCallback: { CheckoutRequestID: checkoutRequestId } } }),
  });
}

async function startPos(t, paymentsBaseUrl, overrides = {}) {
  const paymentsClient = overrides.paymentsClient ?? new PaymentsClient({ baseUrl: paymentsBaseUrl, serviceAuthSecret: TEST_SECRET });
  const entries = [];
  const server = createApp({ paymentsClient, serviceAuthSecret: TEST_SECRET, saleStore: new InMemorySaleStore(), log: (entry) => entries.push(entry) });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { base: `http://127.0.0.1:${server.address().port}`, entries };
}

function postSale(base, body, key = 'sale-request-001', authTenantId = body.tenant_id) {
  return fetch(`${base}/sales`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key, ...authHeader(authTenantId) },
    body: JSON.stringify(body),
  });
}

function pay(base, saleId, tenantId) {
  return fetch(`${base}/sales/${saleId}/pay`, { method: 'POST', headers: { ...authHeader(tenantId) } });
}

function reconcile(base, saleId, tenantId) {
  return fetch(`${base}/sales/${saleId}/reconcile`, { method: 'POST', headers: { ...authHeader(tenantId) } });
}

function getSale(base, saleId, tenantId) {
  return fetch(`${base}/sales/${saleId}`, { headers: { ...authHeader(tenantId) } });
}

function putTenantConfig(base, tenantId, body) {
  return fetch(`${base}/tenants/${tenantId}/config`, {
    method: 'PUT', headers: { 'content-type': 'application/json', ...authHeader(tenantId) }, body: JSON.stringify(body),
  });
}

const validSale = {
  tenant_id: 'tenant_demo_001', attendant_id: 'attendant_demo_001', currency: 'KES', customer_phone: '+254700000001',
  line_items: [
    { description: 'Soda 500ml', quantity: 2, unit_price_minor: 5000 },
    { description: 'Bread', quantity: 1, unit_price_minor: 15000 },
  ],
};

test('creates a sale, computing the total in integer minor units from line items', async (t) => {
  const { baseUrl } = await startPaymentsServer(t);
  const { base } = await startPos(t, baseUrl);
  const created = await postSale(base, validSale);
  assert.equal(created.status, 201);
  const sale = await created.json();
  assert.match(sale.sale_id, /^sale_/);
  assert.equal(sale.attendant_id, 'attendant_demo_001');
  assert.equal(sale.amount_minor, 25000); // 2*5000 + 1*15000
  assert.equal(sale.status, 'unpaid');
});

test('an identical retry returns the same sale; changed input with the same key is rejected', async (t) => {
  const { baseUrl } = await startPaymentsServer(t);
  const { base } = await startPos(t, baseUrl);
  const first = await (await postSale(base, validSale)).json();
  const retry = await postSale(base, validSale);
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), first);

  const changed = await postSale(base, { ...validSale, customer_phone: '+254700000009' });
  assert.equal(changed.status, 409);
  assert.deepEqual(await changed.json(), { error: 'idempotency_key_reused' });
});

test('rejects sales with no line items, non-integer quantities, a missing attendant, or an invalid phone', async (t) => {
  const { baseUrl } = await startPaymentsServer(t);
  const { base } = await startPos(t, baseUrl);
  for (const bad of [
    { ...validSale, line_items: [] },
    { ...validSale, line_items: [{ description: 'x', quantity: 1.5, unit_price_minor: 100 }] },
    { ...validSale, line_items: [{ description: 'x', quantity: 1, unit_price_minor: -1 }] },
    { ...validSale, customer_phone: '0700000001' },
    { ...validSale, attendant_id: '' },
  ]) {
    assert.equal((await postSale(base, bad, `bad-${Math.random()}`)).status, 400);
  }
});

test('a tenant ID in the body alone is not authorization for sale creation or reads', async (t) => {
  const { baseUrl } = await startPaymentsServer(t);
  const { base } = await startPos(t, baseUrl);
  const noAuth = await fetch(`${base}/sales`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'k1' }, body: JSON.stringify(validSale),
  });
  assert.equal(noAuth.status, 401);

  const mismatched = await postSale(base, validSale, 'k2', 'a-different-tenant');
  assert.equal(mismatched.status, 403);

  const sale = await (await postSale(base, validSale)).json();
  const crossTenantRead = await getSale(base, sale.sale_id, 'a-different-tenant');
  assert.equal(crossTenantRead.status, 404);
});

test('the full sale -> STK -> callback -> reconcile -> paid flow', async (t) => {
  const { baseUrl, client, getLastProviderRequestId } = await startPaymentsServer(t);
  const { base } = await startPos(t, baseUrl);

  const sale = await (await postSale(base, validSale)).json();

  const paying = await pay(base, sale.sale_id, sale.tenant_id);
  assert.equal(paying.status, 202);
  assert.equal((await paying.json()).status, 'unpaid');

  // Not yet resolved: reconciling now must not mark the sale paid.
  const early = await reconcile(base, sale.sale_id, sale.tenant_id);
  assert.equal((await early.json()).status, 'unpaid');

  // The provider confirms success; Payments' own callback endpoint verifies
  // it before transitioning — this is the same reconciliation path a real
  // Daraja callback would drive.
  const providerRequestId = getLastProviderRequestId();
  client.simulateOutcome(providerRequestId, 'succeeded');
  assert.equal((await postDarajaCallback(baseUrl, providerRequestId)).status, 200);

  const reconciled = await reconcile(base, sale.sale_id, sale.tenant_id);
  const reconciledSale = await reconciled.json();
  assert.equal(reconciledSale.status, 'paid');

  // Idempotent: reconciling an already-paid sale again changes nothing.
  const again = await reconcile(base, sale.sale_id, sale.tenant_id);
  assert.deepEqual(await again.json(), reconciledSale);

  // Re-initiating payment on a paid sale is rejected outright.
  const rePay = await pay(base, sale.sale_id, sale.tenant_id);
  assert.equal(rePay.status, 409);
});

test('calling /pay twice dispatches only one STK push', async (t) => {
  const { baseUrl, client } = await startPaymentsServer(t);
  let dispatches = 0;
  const initiate = client.initiateStkPush.bind(client);
  client.initiateStkPush = async (input) => { dispatches += 1; return initiate(input); };
  const { base } = await startPos(t, baseUrl);
  const sale = await (await postSale(base, validSale)).json();

  await pay(base, sale.sale_id, sale.tenant_id);
  const second = await pay(base, sale.sale_id, sale.tenant_id);
  assert.equal(second.status, 200);
  assert.equal(dispatches, 1);
});

test('a reconciled payment that does not match the sale record is not applied, and is flagged', async (t) => {
  const entries = [];
  // A stub Payments client standing in for a corrupted/forged response:
  // Payments reports success, but for the wrong sale and the wrong amount.
  const forgedPaymentsClient = {
    requestPayment: async () => ({ payment_id: 'payment_forged', status: 'pending' }),
    getPayment: async () => ({ tenant_id: 'tenant_demo_001', sale_id: 'sale_someone_else', amount_minor: 1, currency: 'KES', status: 'succeeded' }),
  };
  const server = createApp({ paymentsClient: forgedPaymentsClient, serviceAuthSecret: TEST_SECRET, log: (entry) => entries.push(entry) });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  const sale = await (await postSale(base, validSale)).json();
  await pay(base, sale.sale_id, sale.tenant_id);
  const reconciled = await reconcile(base, sale.sale_id, sale.tenant_id);
  assert.equal((await reconciled.json()).status, 'unpaid');
  assert.ok(entries.some((entry) => entry.event === 'reconcile_mismatch'));
});

test('unknown sale ids return 404 for get, pay, and reconcile', async (t) => {
  const { baseUrl } = await startPaymentsServer(t);
  const { base } = await startPos(t, baseUrl);
  assert.equal((await getSale(base, 'sale_missing', 'tenant_demo_001')).status, 404);
  assert.equal((await pay(base, 'sale_missing', 'tenant_demo_001')).status, 404);
  assert.equal((await reconcile(base, 'sale_missing', 'tenant_demo_001')).status, 404);
});

test('tenant configuration: an owner can set attendants and a commission rate, scoped to their own tenant', async (t) => {
  const { baseUrl } = await startPaymentsServer(t);
  const { base } = await startPos(t, baseUrl);
  const config = {
    commission_rate_basis_points: 1000,
    attendants: [{ attendant_id: 'attendant_demo_001', phone: '+254700000009' }],
  };
  const put = await putTenantConfig(base, 'tenant_demo_001', config);
  assert.equal(put.status, 200);
  assert.deepEqual(await put.json(), { tenant_id: 'tenant_demo_001', ...config });

  const get = await fetch(`${base}/tenants/tenant_demo_001/config`, { headers: { ...authHeader('tenant_demo_001') } });
  assert.deepEqual(await get.json(), { tenant_id: 'tenant_demo_001', ...config });

  // A different tenant cannot read or overwrite another tenant's configuration.
  const crossRead = await fetch(`${base}/tenants/tenant_demo_001/config`, { headers: { ...authHeader('a-different-tenant') } });
  assert.equal(crossRead.status, 404);
  const crossWrite = await putTenantConfig(base, 'tenant_demo_001', config).then(async () => fetch(`${base}/tenants/tenant_demo_001/config`, {
    method: 'PUT', headers: { 'content-type': 'application/json', ...authHeader('a-different-tenant') }, body: JSON.stringify(config),
  }));
  assert.equal(crossWrite.status, 404);
});

test('listing paid sales for a tenant only returns that tenant\'s paid sales', async (t) => {
  const { baseUrl, client, getLastProviderRequestId } = await startPaymentsServer(t);
  const { base } = await startPos(t, baseUrl);

  const sale = await (await postSale(base, validSale)).json();
  await pay(base, sale.sale_id, sale.tenant_id);
  client.simulateOutcome(getLastProviderRequestId(), 'succeeded');
  await postDarajaCallback(baseUrl, getLastProviderRequestId());
  await reconcile(base, sale.sale_id, sale.tenant_id);

  // An unpaid sale from the same tenant must not appear in the paid list.
  await postSale(base, validSale, 'sale-request-002');

  const listed = await fetch(`${base}/sales?status=paid&commission_run_id=run1`, { headers: { ...authHeader('tenant_demo_001') } });
  assert.equal(listed.status, 200);
  const { sales } = await listed.json();
  assert.equal(sales.length, 1);
  assert.equal(sales[0].sale_id, sale.sale_id);
  assert.equal(sales[0].status, 'paid');

  const otherTenant = await fetch(`${base}/sales?status=paid&commission_run_id=run1`, { headers: { ...authHeader('a-different-tenant') } });
  assert.deepEqual(await otherTenant.json(), { sales: [] });
});

test('claiming a sale for a commission run excludes it from future runs, but keeps it visible to the same run', async (t) => {
  const { baseUrl, client, getLastProviderRequestId } = await startPaymentsServer(t);
  const { base } = await startPos(t, baseUrl);

  const sale = await (await postSale(base, validSale)).json();
  await pay(base, sale.sale_id, sale.tenant_id);
  client.simulateOutcome(getLastProviderRequestId(), 'succeeded');
  await postDarajaCallback(baseUrl, getLastProviderRequestId());
  await reconcile(base, sale.sale_id, sale.tenant_id);

  const claim = await fetch(`${base}/sales/claim`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...authHeader('tenant_demo_001') },
    body: JSON.stringify({ commission_run_id: 'run_2026-09-15', sale_ids: [sale.sale_id] }),
  });
  assert.equal(claim.status, 204);

  // A different run (e.g. tomorrow's close) must never see this sale again.
  const tomorrow = await fetch(`${base}/sales?status=paid&commission_run_id=run_2026-09-16`, { headers: { ...authHeader('tenant_demo_001') } });
  assert.deepEqual(await tomorrow.json(), { sales: [] });

  // The same run (a retry) must still see it.
  const sameRun = await fetch(`${base}/sales?status=paid&commission_run_id=run_2026-09-15`, { headers: { ...authHeader('tenant_demo_001') } });
  assert.equal((await sameRun.json()).sales.length, 1);

  // Claiming again under the same run is a harmless no-op.
  const reclaim = await fetch(`${base}/sales/claim`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...authHeader('tenant_demo_001') },
    body: JSON.stringify({ commission_run_id: 'run_2026-09-15', sale_ids: [sale.sale_id] }),
  });
  assert.equal(reclaim.status, 204);
});
