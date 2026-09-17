import { createServer } from 'node:http';
import { InMemorySaleStore, toSaleResponse } from './sale-store.js';
import { InMemoryTenantStore, toTenantConfigResponse } from './tenant-store.js';
import { verifyServiceAuth } from '../../_shared/service-auth.js';

const MAX_BODY_BYTES = 16 * 1024;

function sendJson(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) { reject(new Error('body_too_large')); req.destroy(); return; }
      raw += chunk;
    });
    req.on('end', () => { try { resolve(JSON.parse(raw)); } catch { reject(new Error('invalid_json')); } });
    req.on('error', reject);
  });
}

function validString(value, maximum = 128) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

function validateLineItems(lineItems) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) return null;
  let amountMinor = 0;
  const normalized = [];
  for (const item of lineItems) {
    if (!item || typeof item !== 'object') return null;
    if (!validString(item.description, 256)) return null;
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) return null;
    if (!Number.isSafeInteger(item.unit_price_minor) || item.unit_price_minor <= 0) return null;
    amountMinor += item.quantity * item.unit_price_minor;
    normalized.push({ description: item.description.trim(), quantity: item.quantity, unitPriceMinor: item.unit_price_minor });
  }
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) return null;
  return { lineItems: normalized, amountMinor };
}

function validateSale(body, idempotencyKey) {
  if (!validString(idempotencyKey) || !body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (!validString(body.tenant_id) || !validString(body.attendant_id) || body.currency !== 'KES') return null;
  if (typeof body.customer_phone !== 'string' || !/^\+[1-9]\d{6,14}$/.test(body.customer_phone)) return null;
  const items = validateLineItems(body.line_items);
  if (!items) return null;
  const request = {
    tenantId: body.tenant_id.trim(), attendantId: body.attendant_id.trim(), lineItems: items.lineItems, amountMinor: items.amountMinor,
    currency: body.currency, customerPhone: body.customer_phone,
  };
  return { ...request, idempotencyKey: idempotencyKey.trim(), fingerprint: JSON.stringify(request) };
}

function validateTenantConfig(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (!Number.isInteger(body.commission_rate_basis_points) || body.commission_rate_basis_points < 0 || body.commission_rate_basis_points > 10000) return null;
  if (!Array.isArray(body.attendants) || body.attendants.length === 0) return null;
  const attendants = [];
  for (const attendant of body.attendants) {
    if (!attendant || typeof attendant !== 'object') return null;
    if (!validString(attendant.attendant_id) || typeof attendant.phone !== 'string' || !/^\+[1-9]\d{6,14}$/.test(attendant.phone)) return null;
    attendants.push({ id: attendant.attendant_id.trim(), phone: attendant.phone });
  }
  const attendantIds = new Set(attendants.map((attendant) => attendant.id));

  // Tills are optional: an owner who has not described any is configuring a
  // tenant that has none yet, not submitting an invalid request. Each till
  // must reference attendants that exist in this same config, so a till can
  // never point at an attendant the tenant does not have.
  const tills = [];
  if (body.tills !== undefined) {
    if (!Array.isArray(body.tills)) return null;
    const seenTillIds = new Set();
    for (const till of body.tills) {
      if (!till || typeof till !== 'object' || Array.isArray(till)) return null;
      if (!validString(till.till_id, 128) || !validString(till.name, 256)) return null;
      const tillId = till.till_id.trim();
      if (seenTillIds.has(tillId)) return null;
      seenTillIds.add(tillId);
      if (!Array.isArray(till.attendant_ids)) return null;
      const tillAttendantIds = [];
      for (const rawId of till.attendant_ids) {
        if (!validString(rawId)) return null;
        const attendantId = rawId.trim();
        if (!attendantIds.has(attendantId)) return null;
        tillAttendantIds.push(attendantId);
      }
      tills.push({ id: tillId, name: till.name.trim(), attendantIds: tillAttendantIds });
    }
  }

  // Roles are optional too. A role maps a tenant-scoped role name to the set
  // of actions it may perform. Keys are normalised, permission lists are
  // de-duplicated, and both are bounded in length so a tenant cannot smuggle
  // an unbounded blob into the config row.
  const roles = {};
  if (body.roles !== undefined) {
    if (!body.roles || typeof body.roles !== 'object' || Array.isArray(body.roles)) return null;
    for (const [name, permissions] of Object.entries(body.roles)) {
      if (!validString(name, 64)) return null;
      if (!Array.isArray(permissions)) return null;
      const unique = new Set();
      for (const permission of permissions) {
        if (!validString(permission, 64)) return null;
        unique.add(permission.trim());
      }
      roles[name.trim()] = [...unique];
    }
  }

  return { attendants, commissionRateBasisPoints: body.commission_rate_basis_points, tills, roles };
}

function describeRoute(path, method) {
  if (path === '/health') return '/health';
  if (path === '/ready') return '/ready';
  if (path === '/sales') return `${method} /sales`;
  if (path === '/sales/claim') return 'POST /sales/claim';
  if (/^\/sales\/[^/]+$/.test(path)) return 'GET /sales/:id';
  if (/^\/sales\/[^/]+\/pay$/.test(path)) return 'POST /sales/:id/pay';
  if (/^\/sales\/[^/]+\/reconcile$/.test(path)) return 'POST /sales/:id/reconcile';
  if (/^\/tenants\/[^/]+\/config$/.test(path)) return `${method} /tenants/:id/config`;
  return 'unmatched';
}

export function createApp({ paymentsClient, serviceAuthSecret, saleStore = new InMemorySaleStore(), tenantStore = new InMemoryTenantStore(), log = () => {} }) {
  if (!paymentsClient) throw new Error('A Payments client is required');
  if (!serviceAuthSecret) throw new Error('A service auth secret is required');

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://internal');
    const path = url.pathname;
    let statusCode = 500;
    const auth = verifyServiceAuth(req.headers['x-service-auth'], serviceAuthSecret);
    res.on('finish', () => log({ event: 'http_request', route: describeRoute(path, req.method), statusCode }));

    if (path === '/health') {
      if (req.method === 'GET' || req.method === 'HEAD') {
        statusCode = 200;
        res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ service: 'pos', status: 'ok' }));
      } else { statusCode = 405; sendJson(res, statusCode, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' }); }
      return;
    }

    // Readiness: dependencies are reachable, so the ALB may send traffic.
    // This is what the target group polls. The ECS container healthcheck
    // stays on /health so a database blip does not replace every task.
    if (path === '/ready') {
      if (req.method === 'GET' || req.method === 'HEAD') {
        try {
          await saleStore.ping();
          statusCode = 200;
        } catch (error) {
          log({ event: 'readiness_check_failed', code: error.code ?? 'UNKNOWN' });
          statusCode = 503;
        }
        const body = { service: 'pos', status: statusCode === 200 ? 'ready' : 'not_ready' };
        res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
      } else { statusCode = 405; sendJson(res, statusCode, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' }); }
      return;
    }

    if (path === '/sales' && req.method === 'GET') {
      if (!auth) { statusCode = 401; sendJson(res, statusCode, { error: 'unauthenticated' }); return; }
      const commissionRunId = url.searchParams.get('commission_run_id');
      if (url.searchParams.get('status') !== 'paid' || !validString(commissionRunId, 256)) { statusCode = 400; sendJson(res, statusCode, { error: 'invalid_request' }); return; }
      const sales = (await saleStore.listPaid(auth.tenantId, commissionRunId)).map(toSaleResponse);
      statusCode = 200; sendJson(res, statusCode, { sales }); return;
    }

    if (path === '/sales/claim' && req.method === 'POST') {
      if (!auth) { statusCode = 401; sendJson(res, statusCode, { error: 'unauthenticated' }); return; }
      let body;
      try { body = await readJsonBody(req); } catch { body = null; }
      if (!body || !validString(body.commission_run_id, 256) || !Array.isArray(body.sale_ids) || body.sale_ids.some((id) => !validString(id))) {
        statusCode = 400; sendJson(res, statusCode, { error: 'invalid_request' }); return;
      }
      await saleStore.claimForCommissionRun(auth.tenantId, body.commission_run_id, body.sale_ids);
      statusCode = 204; res.writeHead(statusCode); res.end(); return;
    }

    if (path === '/sales' && req.method === 'POST') {
      if (!auth) { statusCode = 401; sendJson(res, statusCode, { error: 'unauthenticated' }); return; }
      let input;
      try { input = validateSale(await readJsonBody(req), req.headers['idempotency-key']); } catch { input = null; }
      if (!input) { statusCode = 400; sendJson(res, statusCode, { error: 'invalid_request' }); return; }
      if (input.tenantId !== auth.tenantId) { statusCode = 403; sendJson(res, statusCode, { error: 'tenant_mismatch' }); return; }
      const result = await saleStore.createOrGet(input);
      if (result.kind === 'idempotency_conflict') { statusCode = 409; sendJson(res, statusCode, { error: 'idempotency_key_reused' }); return; }
      statusCode = result.kind === 'created' ? 201 : 200;
      sendJson(res, statusCode, toSaleResponse(result.sale));
      return;
    }

    const payMatch = /^\/sales\/([^/]+)\/pay$/.exec(path);
    if (payMatch && req.method === 'POST') {
      if (!auth) { statusCode = 401; sendJson(res, statusCode, { error: 'unauthenticated' }); return; }
      const sale = await saleStore.findById(decodeURIComponent(payMatch[1]));
      if (!sale || sale.tenantId !== auth.tenantId) { statusCode = 404; sendJson(res, statusCode, { error: 'not_found' }); return; }
      if (sale.status === 'paid') { statusCode = 409; sendJson(res, statusCode, { error: 'sale_already_paid' }); return; }
      if (sale.paymentId) { statusCode = 200; sendJson(res, statusCode, toSaleResponse(sale)); return; }
      try {
        // The sale's own ID is the idempotency key sent to Payments: it is
        // already unique per sale and stable across retries, so a POS
        // restart or a duplicate /pay call can never dispatch a second STK
        // push for the same sale.
        const payment = await paymentsClient.requestPayment({
          idempotencyKey: sale.id, tenantId: sale.tenantId, saleId: sale.id,
          amountMinor: sale.amountMinor, currency: sale.currency, customerPhone: sale.customerPhone,
        });
        await saleStore.attachPaymentId(sale.id, payment.payment_id);
      } catch (error) {
        log({ event: 'payment_request_failed', saleId: sale.id, message: error.message });
        statusCode = 503; sendJson(res, statusCode, { error: 'payment_request_failed' }); return;
      }
      statusCode = 202; sendJson(res, statusCode, toSaleResponse(await saleStore.findById(sale.id))); return;
    }

    const reconcileMatch = /^\/sales\/([^/]+)\/reconcile$/.exec(path);
    if (reconcileMatch && req.method === 'POST') {
      if (!auth) { statusCode = 401; sendJson(res, statusCode, { error: 'unauthenticated' }); return; }
      const sale = await saleStore.findById(decodeURIComponent(reconcileMatch[1]));
      if (!sale || sale.tenantId !== auth.tenantId) { statusCode = 404; sendJson(res, statusCode, { error: 'not_found' }); return; }
      if (sale.status === 'paid') { statusCode = 200; sendJson(res, statusCode, toSaleResponse(sale)); return; }
      if (!sale.paymentId) { statusCode = 409; sendJson(res, statusCode, { error: 'payment_not_initiated' }); return; }
      const payment = await paymentsClient.getPayment(sale.tenantId, sale.paymentId);
      if (!payment || payment.status !== 'succeeded') {
        statusCode = 200; sendJson(res, statusCode, toSaleResponse(sale)); return;
      }
      // Never trust a bare "succeeded" — the sale is only marked paid once
      // Payments' own record of tenant, sale, amount, and currency for this
      // payment matches POS's own authoritative sale record exactly.
      const matches = payment.tenant_id === sale.tenantId && payment.sale_id === sale.id
        && payment.amount_minor === sale.amountMinor && payment.currency === sale.currency;
      if (!matches) {
        log({ event: 'reconcile_mismatch', saleId: sale.id, paymentId: sale.paymentId, payment });
        statusCode = 200; sendJson(res, statusCode, toSaleResponse(sale)); return;
      }
      const updated = await saleStore.markPaid(sale.id);
      statusCode = 200; sendJson(res, statusCode, toSaleResponse(updated)); return;
    }

    const match = /^\/sales\/([^/]+)$/.exec(path);
    if (match && req.method === 'GET') {
      if (!auth) { statusCode = 401; sendJson(res, statusCode, { error: 'unauthenticated' }); return; }
      const sale = await saleStore.findById(decodeURIComponent(match[1]));
      if (!sale || sale.tenantId !== auth.tenantId) { statusCode = 404; sendJson(res, statusCode, { error: 'not_found' }); return; }
      statusCode = 200; sendJson(res, statusCode, toSaleResponse(sale)); return;
    }

    const tenantConfigMatch = /^\/tenants\/([^/]+)\/config$/.exec(path);
    if (tenantConfigMatch) {
      const tenantId = decodeURIComponent(tenantConfigMatch[1]);
      if (!auth || auth.tenantId !== tenantId) { statusCode = auth ? 404 : 401; sendJson(res, statusCode, { error: auth ? 'not_found' : 'unauthenticated' }); return; }
      if (req.method === 'PUT') {
        let input;
        try { input = validateTenantConfig(await readJsonBody(req)); } catch { input = null; }
        if (!input) { statusCode = 400; sendJson(res, statusCode, { error: 'invalid_request' }); return; }
        const config = await tenantStore.configure(tenantId, input);
        statusCode = 200; sendJson(res, statusCode, toTenantConfigResponse(config)); return;
      }
      if (req.method === 'GET') {
        const config = await tenantStore.get(tenantId);
        if (!config) { statusCode = 404; sendJson(res, statusCode, { error: 'not_found' }); return; }
        statusCode = 200; sendJson(res, statusCode, toTenantConfigResponse(config)); return;
      }
      statusCode = 405; sendJson(res, statusCode, { error: 'method_not_allowed' }, { Allow: 'GET, PUT' }); return;
    }

    if (path === '/sales') { statusCode = 405; sendJson(res, statusCode, { error: 'method_not_allowed' }, { Allow: 'GET, POST' }); return; }
    if (match) { statusCode = 405; sendJson(res, statusCode, { error: 'method_not_allowed' }, { Allow: 'GET' }); return; }
    statusCode = 404; sendJson(res, statusCode, { error: 'not_found' });
  });
}
