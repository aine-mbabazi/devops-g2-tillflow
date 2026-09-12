import { createServer } from 'node:http';
import { InMemoryPaymentStore, toPaymentResponse } from './payment-store.js';

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

export function createApp({ darajaClient, paymentStore = new InMemoryPaymentStore(), log = () => {} }) {
  if (!darajaClient) throw new Error('A Daraja client is required');

  return createServer(async (req, res) => {
    const path = req.url?.split('?')[0] ?? '';
    const isHealth = path === '/health';
    let statusCode = 500;

    res.on('finish', () => log({
      event: 'http_request',
      route: isHealth ? '/health' : path === '/payments' ? 'POST /payments' : /^\/payments\/[^/]+$/.test(path) ? 'GET /payments/:id' : 'unmatched',
      statusCode,
    }));
    if (isHealth) {
      if (req.method === 'GET' || req.method === 'HEAD') {
        statusCode = 200;
        res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ service: 'payments', status: 'ok' }));
      } else { statusCode = 405; sendJson(res, statusCode, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' }); }
      return;
    }
    if (path === '/payments' && req.method === 'POST') {
      let input;
      try { input = validatePayment(await readJsonBody(req), req.headers['idempotency-key']); } catch { input = null; }
      if (!input) { statusCode = 400; sendJson(res, statusCode, { error: 'invalid_request' }); return; }
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
    const match = /^\/payments\/([^/]+)$/.exec(path);
    if (match && req.method === 'GET') {
      const payment = await paymentStore.findById(decodeURIComponent(match[1]));
      if (!payment) { statusCode = 404; sendJson(res, statusCode, { error: 'not_found' }); return; }
      statusCode = 200; sendJson(res, statusCode, toPaymentResponse(payment)); return;
    }
    if (path === '/payments') { statusCode = 405; sendJson(res, statusCode, { error: 'method_not_allowed' }, { Allow: 'POST' }); return; }
    if (match) { statusCode = 405; sendJson(res, statusCode, { error: 'method_not_allowed' }, { Allow: 'GET' }); return; }
    statusCode = 404; sendJson(res, statusCode, { error: 'not_found' });
  });
}
