import { createServer } from 'node:http';
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

function describeRoute(path, method) {
  if (path === '/health') return '/health';
  if (path === '/ready') return '/ready';
  if (path === '/sales' && method === 'POST') return 'POST /sales';
  if (/^\/sales\/[^/]+\/pay$/.test(path)) return 'POST /sales/:id/pay';
  if (/^\/sales\/[^/]+$/.test(path)) return 'GET /sales/:id';
  if (/^\/payments\/[^/]+$/.test(path)) return 'GET /payments/:id';
  return 'unmatched';
}

// web is the WEB stage of the required WEB -> API GATEWAY -> SERVICES
// architecture: a thin, stateless entry point in front of POS and Payments.
// It owns no money state and makes no authorization decisions of its own — a
// caller's signed x-service-auth token is verified here (to fail fast with a
// clean 401 instead of a confusing proxied error) and then forwarded to the
// downstream service unchanged, which verifies it again independently.
// There is deliberately no end-user identity layer behind that token; that
// gap is disclosed in docs/production-readiness.md, not papered over here
// with a second, weaker auth scheme of web's own.
export function createApp({ posClient, paymentsClient, serviceAuthSecret, log = () => {} }) {
  if (!posClient) throw new Error('A POS client is required');
  if (!paymentsClient) throw new Error('A Payments client is required');
  if (!serviceAuthSecret) throw new Error('A service auth secret is required');

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://internal');
    const path = url.pathname;
    let statusCode = 500;
    res.on('finish', () => log({ event: 'http_request', route: describeRoute(path, req.method), statusCode }));

    if (path === '/health') {
      if (req.method === 'GET' || req.method === 'HEAD') {
        statusCode = 200;
        res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ service: 'web', status: 'ok' }));
      } else { statusCode = 405; sendJson(res, statusCode, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' }); }
      return;
    }

    // Readiness: both downstream services must be reachable before the ALB
    // sends traffic here. A web tier that answers /health but cannot reach
    // POS or Payments cannot serve a single real request.
    if (path === '/ready') {
      if (req.method === 'GET' || req.method === 'HEAD') {
        const [posUp, paymentsUp] = await Promise.all([
          posClient.health().catch(() => false),
          paymentsClient.health().catch(() => false),
        ]);
        statusCode = posUp && paymentsUp ? 200 : 503;
        if (statusCode !== 200) log({ event: 'readiness_check_failed', posUp, paymentsUp });
        const body = { service: 'web', status: statusCode === 200 ? 'ready' : 'not_ready' };
        res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
      } else { statusCode = 405; sendJson(res, statusCode, { error: 'method_not_allowed' }, { Allow: 'GET, HEAD' }); }
      return;
    }

    const rawAuth = req.headers['x-service-auth'];
    const auth = verifyServiceAuth(rawAuth, serviceAuthSecret);

    if (path === '/sales' && req.method === 'POST') {
      if (!auth) { statusCode = 401; sendJson(res, statusCode, { error: 'unauthenticated' }); return; }
      let body;
      try { body = await readJsonBody(req); } catch { statusCode = 400; sendJson(res, statusCode, { error: 'invalid_request' }); return; }
      const idempotencyKey = req.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
        statusCode = 400; sendJson(res, statusCode, { error: 'invalid_request' }); return;
      }
      try {
        const upstream = await posClient.createSale({ authHeader: rawAuth, idempotencyKey, body });
        statusCode = upstream.status; sendJson(res, statusCode, upstream.body);
      } catch (error) {
        log({ event: 'upstream_request_failed', target: 'pos', message: error.message });
        statusCode = 502; sendJson(res, statusCode, { error: 'upstream_unavailable' });
      }
      return;
    }

    const payMatch = /^\/sales\/([^/]+)\/pay$/.exec(path);
    if (payMatch && req.method === 'POST') {
      if (!auth) { statusCode = 401; sendJson(res, statusCode, { error: 'unauthenticated' }); return; }
      try {
        const upstream = await posClient.pay({ authHeader: rawAuth, saleId: decodeURIComponent(payMatch[1]) });
        statusCode = upstream.status; sendJson(res, statusCode, upstream.body);
      } catch (error) {
        log({ event: 'upstream_request_failed', target: 'pos', message: error.message });
        statusCode = 502; sendJson(res, statusCode, { error: 'upstream_unavailable' });
      }
      return;
    }

    const saleMatch = /^\/sales\/([^/]+)$/.exec(path);
    if (saleMatch && req.method === 'GET') {
      if (!auth) { statusCode = 401; sendJson(res, statusCode, { error: 'unauthenticated' }); return; }
      try {
        const upstream = await posClient.getSale({ authHeader: rawAuth, saleId: decodeURIComponent(saleMatch[1]) });
        statusCode = upstream.status; sendJson(res, statusCode, upstream.body);
      } catch (error) {
        log({ event: 'upstream_request_failed', target: 'pos', message: error.message });
        statusCode = 502; sendJson(res, statusCode, { error: 'upstream_unavailable' });
      }
      return;
    }

    const paymentMatch = /^\/payments\/([^/]+)$/.exec(path);
    if (paymentMatch && req.method === 'GET') {
      if (!auth) { statusCode = 401; sendJson(res, statusCode, { error: 'unauthenticated' }); return; }
      try {
        const upstream = await paymentsClient.getPayment({ authHeader: rawAuth, paymentId: decodeURIComponent(paymentMatch[1]) });
        statusCode = upstream.status; sendJson(res, statusCode, upstream.body);
      } catch (error) {
        log({ event: 'upstream_request_failed', target: 'payments', message: error.message });
        statusCode = 502; sendJson(res, statusCode, { error: 'upstream_unavailable' });
      }
      return;
    }

    if (path === '/sales') { statusCode = 405; sendJson(res, statusCode, { error: 'method_not_allowed' }, { Allow: 'POST' }); return; }
    statusCode = 404; sendJson(res, statusCode, { error: 'not_found' });
  });
}
