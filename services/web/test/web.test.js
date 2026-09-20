import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { PosClient } from '../src/pos-client.js';
import { PaymentsClient } from '../src/payments-client.js';
import { signServiceAuth } from '../../_shared/service-auth.js';

// Drives web against real POS and Payments HTTP servers (the Payments side
// backed by the deterministic fake Daraja adapter), so the full
// web -> POS -> Payments proxy path is proven end to end, not just mocked.
import { createApp as createPosApp } from '../../pos/src/app.js';
import { createApp as createPaymentsApp } from '../../payments/src/app.js';
import { FakeDarajaClient } from '../../payments/src/daraja/fake-client.js';
import { PaymentsClient as PosPaymentsClient } from '../../pos/src/payments-client.js';
import { InMemorySaleStore } from '../../pos/src/sale-store.js';

const TEST_SECRET = 'test-service-auth-secret';
function authHeader(tenantId) {
  return { 'x-service-auth': signServiceAuth(tenantId, TEST_SECRET) };
}

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

async function startPosServer(t, paymentsBaseUrl) {
  const paymentsClient = new PosPaymentsClient({ baseUrl: paymentsBaseUrl, serviceAuthSecret: TEST_SECRET });
  const server = createPosApp({ paymentsClient, serviceAuthSecret: TEST_SECRET, saleStore: new InMemorySaleStore() });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function startWeb(t, posBaseUrl, paymentsBaseUrl) {
  const posClient = new PosClient({ baseUrl: posBaseUrl });
  const paymentsClient = new PaymentsClient({ baseUrl: paymentsBaseUrl });
  const entries = [];
  const server = createApp({ posClient, paymentsClient, serviceAuthSecret: TEST_SECRET, log: (entry) => entries.push(entry) });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { base: `http://127.0.0.1:${server.address().port}`, entries };
}

async function setup(t) {
  const { baseUrl: paymentsBaseUrl } = await startPaymentsServer(t);
  const posBaseUrl = await startPosServer(t, paymentsBaseUrl);
  return startWeb(t, posBaseUrl, paymentsBaseUrl);
}

const validSale = {
  tenant_id: 'tenant_demo_001', attendant_id: 'attendant_demo_001', currency: 'KES', customer_phone: '+254700000001',
  line_items: [{ description: 'Soda 500ml', quantity: 2, unit_price_minor: 5000 }],
};

test('configuration requires a service auth secret and validates URLs', () => {
  assert.throws(() => loadConfig({}), /SERVICE_AUTH_SECRET/);
  assert.deepEqual(loadConfig({ SERVICE_AUTH_SECRET: TEST_SECRET }), {
    host: '127.0.0.1', port: 3003, posBaseUrl: 'http://127.0.0.1:3002',
    paymentsBaseUrl: 'http://127.0.0.1:3001', serviceAuthSecret: TEST_SECRET,
  });
  assert.throws(() => loadConfig({ SERVICE_AUTH_SECRET: TEST_SECRET, POS_BASE_URL: 'not-a-url' }), /POS_BASE_URL/);
  assert.throws(() => loadConfig({ SERVICE_AUTH_SECRET: TEST_SECRET, PAYMENTS_BASE_URL: 'not-a-url' }), /PAYMENTS_BASE_URL/);
});

test('/health is a liveness check that requires no auth and no dependency', async (t) => {
  const { base } = await setup(t);
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { service: 'web', status: 'ok' });
});

test('/ready is 200 only when both POS and Payments are reachable', async (t) => {
  const { base } = await setup(t);
  const response = await fetch(`${base}/ready`);
  assert.equal(response.status, 200);

  // A server that has already been closed refuses the connection immediately,
  // unlike an arbitrary unused port, which can sit unanswered until a slow
  // OS-level connect timeout.
  const closedServer = (await import('node:http')).createServer();
  closedServer.listen(0, '127.0.0.1');
  await once(closedServer, 'listening');
  const deadPort = closedServer.address().port;
  await new Promise((resolve) => closedServer.close(resolve));

  const posClient = new PosClient({ baseUrl: `http://127.0.0.1:${deadPort}` });
  const paymentsClient = new PaymentsClient({ baseUrl: `http://127.0.0.1:${deadPort}` });
  const brokenWeb = createApp({ posClient, paymentsClient, serviceAuthSecret: TEST_SECRET });
  t.after(() => new Promise((resolve) => { brokenWeb.close(resolve); brokenWeb.closeAllConnections(); }));
  brokenWeb.listen(0, '127.0.0.1');
  await once(brokenWeb, 'listening');
  const brokenResponse = await fetch(`http://127.0.0.1:${brokenWeb.address().port}/ready`);
  assert.equal(brokenResponse.status, 503);
});

test('every proxied route requires a valid service-auth token', async (t) => {
  const { base } = await setup(t);
  const unauthed = await Promise.all([
    fetch(`${base}/sales`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'k' }, body: JSON.stringify(validSale) }),
    fetch(`${base}/sales/sale_x`),
    fetch(`${base}/sales/sale_x/pay`, { method: 'POST' }),
    fetch(`${base}/payments/payment_x`),
  ]);
  for (const response of unauthed) assert.equal(response.status, 401);
});

test('proxies a full sale -> pay -> payment status flow to POS and Payments unchanged', async (t) => {
  const { base, entries } = await setup(t);

  const created = await fetch(`${base}/sales`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'web-key-001', ...authHeader(validSale.tenant_id) },
    body: JSON.stringify(validSale),
  });
  assert.equal(created.status, 201);
  const sale = await created.json();
  assert.equal(sale.amount_minor, 10000);

  const fetched = await fetch(`${base}/sales/${sale.sale_id}`, { headers: authHeader(validSale.tenant_id) });
  assert.equal(fetched.status, 200);
  assert.deepEqual(await fetched.json(), sale);

  const paid = await fetch(`${base}/sales/${sale.sale_id}/pay`, { method: 'POST', headers: authHeader(validSale.tenant_id) });
  assert.equal(paid.status, 202);
  const paidSale = await paid.json();
  assert.ok(paidSale.payment_id);

  const payment = await fetch(`${base}/payments/${paidSale.payment_id}`, { headers: authHeader(validSale.tenant_id) });
  assert.equal(payment.status, 200);
  const paymentBody = await payment.json();
  assert.equal(paymentBody.sale_id, sale.sale_id);
  assert.equal(paymentBody.status, 'pending');

  // web logs its own request outcomes rather than the proxied body, matching
  // the other services' rule of not logging request/response payloads.
  const httpLogs = entries.filter((entry) => entry.event === 'http_request');
  assert.ok(httpLogs.some((entry) => entry.route === 'POST /sales' && entry.statusCode === 201));
});

test('a nonexistent sale proxies through as a 404 from POS, not a web-level error', async (t) => {
  const { base } = await setup(t);
  const response = await fetch(`${base}/sales/does-not-exist`, { headers: authHeader('tenant_demo_001') });
  assert.equal(response.status, 404);
});

test('an unroutable path is a plain 404', async (t) => {
  const { base } = await setup(t);
  const response = await fetch(`${base}/nope`);
  assert.equal(response.status, 404);
});
