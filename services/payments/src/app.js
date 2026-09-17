import { createServer } from 'node:http';
import { InMemoryPaymentStore, toPaymentResponse } from './payment-store.js';
import { InMemoryPayoutStore, toPayoutResponse } from './payout-store.js';
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

function validatePayment(body, idempotencyKey) {
  if (!validString(idempotencyKey) || !body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (!validString(body.tenant_id) || !validString(body.sale_id)) return null;
  if (!Number.isSafeInteger(body.amount_minor) || body.amount_minor <= 0 || body.currency !== 'KES') return null;
  if (typeof body.customer_phone !== 'string' || !/^\+[1-9]\d{6,14}$/.test(body.customer_phone)) return null;
  const request = {
    tenantId: body.tenant_id.trim(), saleId: body.sale_id.trim(), amountMinor: body.amount_minor,
    currency: body.currency, customerPhone: body.customer_phone,
  };
  return { ...request, idempotencyKey: idempotencyKey.trim(), fingerprint: JSON.stringify(request) };
}

function describeRoute(path, method) {
  if (path === '/health') return '/health';
  if (path === '/ready') return '/ready';
  if (path === '/payments') return `${method} /payments`;
  if (path === '/payments/callbacks/daraja') return 'POST /payments/callbacks/daraja';
  if (/^\/payments\/[^/]+$/.test(path)) return 'GET /payments/:id';
  if (path === '/payouts') return `${method} /payouts`;
  if (path === '/payouts/callbacks/daraja') return 'POST /payouts/callbacks/daraja';
  if (/^\/payouts\/[^/]+$/.test(path)) return 'GET /payouts/:id';
  return 'unmatched';
}

function validatePayout(body, idempotencyKey) {
  if (!validString(idempotencyKey) || !body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (!validString(body.tenant_id) || !validString(body.attendant_id) || !validString(body.commission_run_id)) return null;
  if (!Number.isSafeInteger(body.amount_minor) || body.amount_minor <= 0 || body.currency !== 'KES') return null;
  if (typeof body.recipient_phone !== 'string' || !/^\+[1-9]\d{6,14}$/.test(body.recipient_phone)) return null;
  const request = {
    tenantId: body.tenant_id.trim(), attendantId: body.attendant_id.trim(), commissionRunId: body.commission_run_id.trim(),
    amountMinor: body.amount_minor, currency: body.currency, recipientPhone: body.recipient_phone,
  };
  return { ...request, idempotencyKey: idempotencyKey.trim(), fingerprint: JSON.stringify(request) };
}

export function createApp({ darajaClient, serviceAuthSecret, paymentStore = new InMemoryPaymentStore(), payoutStore = new InMemoryPayoutStore(), log = () => {} }) {
  if (!darajaClient) throw new Error('A Daraja client is required');
  if (!serviceAuthSecret) throw new Error('A service auth secret is required');

  return createServer(async (req, res) => {
    const path = req.url?.split('?')[0] ?? '';
    const isHealth = path === '/health';
    const isReady = path === '/ready';
    let statusCode = 500;
    // A tenant ID in a request body or path is never authorization on its
    // own — every tenant-scoped route below authenticates the caller first.
    const auth = verifyServiceAuth(req.headers['x-service-auth'], serviceAuthSecret);

    res.on('finish', () => log({ event: 'http_request', route: describeRoute(path, req.method), statusCode }));
    // Liveness: the process is up. Dependency-free on purpose — this is what
    // the load balancer probes, so a database blip must not make it fail and
    // get every task replaced.
    if (isHealth) {
      if (req.method === 'GET' || req.method === 'HEAD') {
        statusCode = 200;
        res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ service: 'payments', status: 'ok' }));
      } else { statusCode = 405; sendJson(res, statusCode, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' }); }
      return;
    }
    // Readiness: dependencies are reachable, so the load balancer may send
    // traffic. This is what the ALB target group polls.
    if (isReady) {
      if (req.method === 'GET' || req.method === 'HEAD') {
        try {
          await paymentStore.ping();
          statusCode = 200;
        } catch (error) {
          log({ event: 'readiness_check_failed', code: error.code ?? 'UNKNOWN' });
          statusCode = 503;
        }
        const body = { service: 'payments', status: statusCode === 200 ? 'ready' : 'not_ready' };
        res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
      } else { statusCode = 405; sendJson(res, statusCode, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' }); }
      return;
    }
    if (path === '/payments' && req.method === 'POST') {
      if (!auth) { statusCode = 401; sendJson(res, statusCode, { error: 'unauthenticated' }); return; }
      let input;
      try { input = validatePayment(await readJsonBody(req), req.headers['idempotency-key']); } catch { input = null; }
      if (!input) { statusCode = 400; sendJson(res, statusCode, { error: 'invalid_request' }); return; }
      if (input.tenantId !== auth.tenantId) { statusCode = 403; sendJson(res, statusCode, { error: 'tenant_mismatch' }); return; }
      const result = await paymentStore.createOrGet(input);
      if (result.kind === 'idempotency_conflict') { statusCode = 409; sendJson(res, statusCode, { error: 'idempotency_key_reused' }); return; }
      if (result.kind === 'sale_conflict') { statusCode = 409; sendJson(res, statusCode, { error: 'sale_payment_exists' }); return; }
      if (result.kind === 'created') {
        try {
          const provider = await darajaClient.initiateStkPush({ amountMinor: input.amountMinor, currency: input.currency, phone: input.customerPhone, reference: result.payment.id });
          await paymentStore.attachProviderRequest(result.payment.id, provider.providerRequestId);
        } catch (error) {
          // It is already recorded: reconciliation, never another create, resolves this later.
          log({ event: 'provider_dispatch_unconfirmed', paymentId: result.payment.id, code: error.code ?? 'UNKNOWN' });
        }
      }
      statusCode = result.payment.status === 'pending' ? 202 : 200;
      sendJson(res, statusCode, toPaymentResponse(result.payment));
      return;
    }
    if (path === '/payments/callbacks/daraja' && req.method === 'POST') {
      let checkoutRequestId;
      try { checkoutRequestId = (await readJsonBody(req))?.Body?.stkCallback?.CheckoutRequestID; } catch { checkoutRequestId = null; }
      if (!validString(checkoutRequestId)) { statusCode = 400; sendJson(res, statusCode, { error: 'invalid_callback' }); return; }
      const payment = await paymentStore.findByProviderRequestId(checkoutRequestId);
      if (!payment) { statusCode = 404; sendJson(res, statusCode, { error: 'not_found' }); return; }
      let verified;
      try { verified = await darajaClient.queryPayment(checkoutRequestId); } catch (error) {
        log({ event: 'callback_verification_unconfirmed', paymentId: payment.id, code: error.code ?? 'UNKNOWN' });
        statusCode = 202; sendJson(res, statusCode, { status: 'pending' }); return;
      }
      if (!['succeeded', 'failed'].includes(verified.status)) { statusCode = 202; sendJson(res, statusCode, { status: 'pending' }); return; }
      if (payment.status !== 'pending' && payment.status !== verified.status) {
        log({ event: 'callback_conflict', paymentId: payment.id, storedStatus: payment.status, verifiedStatus: verified.status });
      }
      const updated = await paymentStore.transition(payment.id, verified.status);
      statusCode = 200; sendJson(res, statusCode, toPaymentResponse(updated)); return;
    }
    const match = /^\/payments\/([^/]+)$/.exec(path);
    if (match && req.method === 'GET') {
      if (!auth) { statusCode = 401; sendJson(res, statusCode, { error: 'unauthenticated' }); return; }
      const payment = await paymentStore.findById(decodeURIComponent(match[1]));
      // A payment belonging to another tenant returns 404, identical to a
      // truly missing one — never reveal that it exists to the wrong caller.
      if (!payment || payment.tenantId !== auth.tenantId) { statusCode = 404; sendJson(res, statusCode, { error: 'not_found' }); return; }
      statusCode = 200; sendJson(res, statusCode, toPaymentResponse(payment)); return;
    }
    if (path === '/payouts' && req.method === 'POST') {
      if (!auth) { statusCode = 401; sendJson(res, statusCode, { error: 'unauthenticated' }); return; }
      let input;
      try { input = validatePayout(await readJsonBody(req), req.headers['idempotency-key']); } catch { input = null; }
      if (!input) { statusCode = 400; sendJson(res, statusCode, { error: 'invalid_request' }); return; }
      if (input.tenantId !== auth.tenantId) { statusCode = 403; sendJson(res, statusCode, { error: 'tenant_mismatch' }); return; }
      const result = await payoutStore.createOrGet(input);
      if (result.kind === 'idempotency_conflict') { statusCode = 409; sendJson(res, statusCode, { error: 'idempotency_key_reused' }); return; }
      if (result.kind === 'ledger_conflict') { statusCode = 409; sendJson(res, statusCode, { error: 'payout_already_exists' }); return; }
      if (result.kind === 'created') {
        try {
          const provider = await darajaClient.initiateB2C({ amountMinor: input.amountMinor, currency: input.currency, phone: input.recipientPhone, reference: result.payout.id });
          await payoutStore.attachProviderRequest(result.payout.id, provider.providerRequestId);
        } catch (error) {
          // Same rule as payments: already durably recorded, reconciliation resolves it, never another create.
          log({ event: 'provider_dispatch_unconfirmed', payoutId: result.payout.id, code: error.code ?? 'UNKNOWN' });
        }
      }
      statusCode = result.payout.status === 'pending' ? 202 : 200;
      sendJson(res, statusCode, toPayoutResponse(result.payout));
      return;
    }
    if (path === '/payouts/callbacks/daraja' && req.method === 'POST') {
      let providerRequestId;
      try { providerRequestId = (await readJsonBody(req))?.Result?.ConversationID; } catch { providerRequestId = null; }
      if (!validString(providerRequestId)) { statusCode = 400; sendJson(res, statusCode, { error: 'invalid_callback' }); return; }
      const payout = await payoutStore.findByProviderRequestId(providerRequestId);
      if (!payout) { statusCode = 404; sendJson(res, statusCode, { error: 'not_found' }); return; }
      let verified;
      try { verified = await darajaClient.queryB2C(providerRequestId); } catch (error) {
        log({ event: 'callback_verification_unconfirmed', payoutId: payout.id, code: error.code ?? 'UNKNOWN' });
        statusCode = 202; sendJson(res, statusCode, { status: 'pending' }); return;
      }
      if (!['succeeded', 'failed'].includes(verified.status)) { statusCode = 202; sendJson(res, statusCode, { status: 'pending' }); return; }
      if (payout.status !== 'pending' && payout.status !== verified.status) {
        log({ event: 'callback_conflict', payoutId: payout.id, storedStatus: payout.status, verifiedStatus: verified.status });
      }
      const updated = await payoutStore.transition(payout.id, verified.status);
      statusCode = 200; sendJson(res, statusCode, toPayoutResponse(updated)); return;
    }
    const payoutMatch = /^\/payouts\/([^/]+)$/.exec(path);
    if (payoutMatch && req.method === 'GET') {
      if (!auth) { statusCode = 401; sendJson(res, statusCode, { error: 'unauthenticated' }); return; }
      const payout = await payoutStore.findById(decodeURIComponent(payoutMatch[1]));
      if (!payout || payout.tenantId !== auth.tenantId) { statusCode = 404; sendJson(res, statusCode, { error: 'not_found' }); return; }
      statusCode = 200; sendJson(res, statusCode, toPayoutResponse(payout)); return;
    }
    if (path === '/payments') { statusCode = 405; sendJson(res, statusCode, { error: 'method_not_allowed' }, { Allow: 'POST' }); return; }
    if (match) { statusCode = 405; sendJson(res, statusCode, { error: 'method_not_allowed' }, { Allow: 'GET' }); return; }
    if (path === '/payouts') { statusCode = 405; sendJson(res, statusCode, { error: 'method_not_allowed' }, { Allow: 'POST' }); return; }
    if (payoutMatch) { statusCode = 405; sendJson(res, statusCode, { error: 'method_not_allowed' }, { Allow: 'GET' }); return; }
    statusCode = 404; sendJson(res, statusCode, { error: 'not_found' });
  });
}
