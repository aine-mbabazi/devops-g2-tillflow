import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { FakeDarajaClient } from '../src/daraja/fake-client.js';
import { DarajaSandboxClient } from '../src/daraja/sandbox-client.js';

test('configuration defaults to local fake mode and rejects invalid settings', () => {
  assert.deepEqual(loadConfig({}), {
    host: '127.0.0.1', port: 3001, darajaMode: 'fake', paymentStore: 'memory', databaseUrl: undefined,
    sandbox: { consumerKey: undefined, consumerSecret: undefined, shortcode: undefined, passkey: undefined, callbackUrl: undefined, timeoutMs: 10000 },
  });
  for (const port of ['0', '-1', '65536', '3001x', '1.5', '']) {
    assert.throws(() => loadConfig({ PORT: port }), /PORT/);
  }
  assert.throws(() => loadConfig({ DARAJA_MODE: 'production' }), /DARAJA_MODE/);
  assert.throws(() => loadConfig({ HOST: '' }), /HOST/);
  assert.throws(() => loadConfig({ PAYMENT_STORE: 'postgres' }), /DATABASE_URL/);
  assert.throws(() => loadConfig({ PAYMENT_STORE: 'unknown' }), /PAYMENT_STORE/);
  assert.throws(() => loadConfig({ DARAJA_MODE: 'sandbox' }), /credentials/);
  const sandboxEnv = { DARAJA_MODE: 'sandbox', DARAJA_CONSUMER_KEY: 'key', DARAJA_CONSUMER_SECRET: 'secret', DARAJA_STK_SHORTCODE: '174379', DARAJA_STK_PASSKEY: 'passkey', DARAJA_STK_CALLBACK_URL: 'https://example.test/callback' };
  assert.throws(() => loadConfig({ ...sandboxEnv, DARAJA_STK_CALLBACK_URL: 'http://example.test/callback' }), /HTTPS/);
  assert.throws(() => loadConfig({ ...sandboxEnv, DARAJA_STK_SHORTCODE: 'x' }), /numeric/);
  assert.throws(() => loadConfig({ ...sandboxEnv, DARAJA_TIMEOUT_MS: '1' }), /TIMEOUT/);
});

test('Daraja sandbox client requests OAuth then sends one STK Push with a provider ID', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('/oauth/')) return new Response(JSON.stringify({ access_token: 'sandbox-token' }), { status: 200 });
    return new Response(JSON.stringify({ CheckoutRequestID: 'ws_CO_123' }), { status: 200 });
  };
  const client = new DarajaSandboxClient({
    consumerKey: 'key', consumerSecret: 'secret', shortcode: '174379', passkey: 'passkey',
    callbackUrl: 'https://example.test/callback', fetchImpl, now: () => new Date('2026-01-02T00:04:05Z'),
  });
  const result = await client.initiateStkPush({ amountMinor: 10000, currency: 'KES', phone: '+254700000001', reference: 'payment_demo_001' });
  assert.deepEqual(result, { providerRequestId: 'ws_CO_123', status: 'pending' });
  assert.equal(calls.length, 2);
  assert.match(calls[0].options.headers.Authorization, /^Basic /);
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.Amount, 100);
  assert.equal(body.PhoneNumber, '254700000001');
  assert.equal(body.AccountReference, 'payment_demo_001');
  assert.equal(body.Timestamp, '20260102030405');
  await assert.rejects(client.initiateStkPush({ amountMinor: 101, currency: 'KES', phone: '+254700000001', reference: 'x' }), /whole KES/);
});

test('Daraja client reuses an unexpired OAuth token and classifies timeout uncertainty', async () => {
  let now = new Date('2026-01-02T00:00:00Z');
  let oauthCalls = 0;
  const client = new DarajaSandboxClient({
    consumerKey: 'key', consumerSecret: 'secret', shortcode: '174379', passkey: 'passkey', callbackUrl: 'https://example.test/callback',
    now: () => now,
    fetchImpl: async (url) => {
      if (url.includes('/oauth/')) { oauthCalls += 1; return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 })); }
      return new Response(JSON.stringify({ CheckoutRequestID: `ws_${oauthCalls}` }));
    },
  });
  await client.initiateStkPush({ amountMinor: 100, currency: 'KES', phone: '+254700000001', reference: 'one' });
  now = new Date('2026-01-02T00:10:00Z');
  await client.initiateStkPush({ amountMinor: 100, currency: 'KES', phone: '+254700000001', reference: 'two' });
  assert.equal(oauthCalls, 1);
  const timeoutClient = new DarajaSandboxClient({
    consumerKey: 'key', consumerSecret: 'secret', shortcode: '174379', passkey: 'passkey', callbackUrl: 'https://example.test/callback',
    fetchImpl: async (_url, { signal }) => await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))), timeoutMs: 1,
  });
  await assert.rejects(timeoutClient.initiateStkPush({ amountMinor: 100, currency: 'KES', phone: '+254700000001', reference: 'three' }), (error) => error.code === 'DARAJA_TIMEOUT');
});

test('HTTP health works; payment routes are not exposed and logs omit query data', async (t) => {
  const entries = [];
  const server = createApp({ darajaClient: new FakeDarajaClient(), log: (entry) => entries.push(entry) });
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/health?phone=synthetic-private-value`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { service: 'payments', status: 'ok' });
  const head = await fetch(`${base}/health`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const post = await fetch(`${base}/health`, { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
  const missing = await fetch(`${base}/unknown`, { method: 'POST' });
  assert.equal(missing.status, 404);
  assert.ok(entries.length >= 4);
  assert.ok(!JSON.stringify(entries).includes('synthetic-private-value'));
});

test('fake payment stays pending until explicitly resolved; replay preserves outcome', async () => {
  const client = new FakeDarajaClient();
  const payment = await client.initiateStkPush({ amountMinor: 10000, currency: 'KES', phone: 'synthetic-test-phone' });
  assert.equal(payment.status, 'pending');
  assert.deepEqual(await client.queryPayment(payment.providerRequestId), payment);
  client.simulateOutcome(payment.providerRequestId, 'succeeded');
  client.simulateOutcome(payment.providerRequestId, 'succeeded');
  assert.equal((await client.queryPayment(payment.providerRequestId)).status, 'succeeded');
  assert.throws(() => client.simulateOutcome(payment.providerRequestId, 'failed'), /terminal/);
  await assert.rejects(client.queryPayment('unknown'), /Unknown/);
});

test('fake client rejects invalid money and allows a definitive failure', async () => {
  const client = new FakeDarajaClient();
  for (const amountMinor of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(client.initiateStkPush({ amountMinor, currency: 'KES', phone: 'test' }), /amountMinor/);
  }
  const payment = await client.initiateStkPush({ amountMinor: 100, currency: 'KES', phone: 'test' });
  client.simulateOutcome(payment.providerRequestId, 'failed');
  assert.equal((await client.queryPayment(payment.providerRequestId)).status, 'failed');
});

async function startPayments(t) {
  const client = new FakeDarajaClient();
  let calls = 0;
  const initiate = client.initiateStkPush.bind(client);
  client.initiateStkPush = async (input) => { calls += 1; return initiate(input); };
  const server = createApp({ darajaClient: client });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { base: `http://127.0.0.1:${server.address().port}`, getCalls: () => calls };
}

function requestPayment(base, body, key = 'payment-request-001') {
  return fetch(`${base}/payments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  });
}

const validPayment = {
  tenant_id: 'tenant_demo_001', sale_id: 'sale_demo_001', amount_minor: 10000,
  currency: 'KES', customer_phone: '+254700000001',
};

test('creates and returns a pending payment attempt', async (t) => {
  const { base, getCalls } = await startPayments(t);
  const created = await requestPayment(base, validPayment);
  assert.equal(created.status, 202);
  const payment = await created.json();
  assert.match(payment.payment_id, /^payment_/);
  assert.deepEqual({ ...payment, payment_id: 'ignored' }, {
    payment_id: 'ignored', tenant_id: 'tenant_demo_001', sale_id: 'sale_demo_001',
    amount_minor: 10000, currency: 'KES', status: 'pending',
  });
  assert.equal(getCalls(), 1);
  const fetched = await fetch(`${base}/payments/${payment.payment_id}`);
  assert.equal(fetched.status, 200);
  assert.deepEqual(await fetched.json(), payment);
});

test('returns the same payment for an identical retry without a second dispatch', async (t) => {
  const { base, getCalls } = await startPayments(t);
  const first = await requestPayment(base, validPayment);
  const original = await first.json();
  const retry = await requestPayment(base, validPayment);
  assert.equal(retry.status, 202);
  assert.deepEqual(await retry.json(), original);
  assert.equal(getCalls(), 1);
});

test('rejects changed idempotency input, a duplicate sale, and invalid requests', async (t) => {
  const { base, getCalls } = await startPayments(t);
  assert.equal((await requestPayment(base, validPayment)).status, 202);
  const changed = await requestPayment(base, { ...validPayment, amount_minor: 20000 });
  assert.equal(changed.status, 409);
  assert.deepEqual(await changed.json(), { error: 'idempotency_key_reused' });
  const duplicate = await requestPayment(base, validPayment, 'payment-request-002');
  assert.equal(duplicate.status, 409);
  assert.deepEqual(await duplicate.json(), { error: 'sale_payment_exists' });
  const invalid = await requestPayment(base, { ...validPayment, customer_phone: '0700000001' }, 'payment-request-003');
  assert.equal(invalid.status, 400);
  assert.equal(getCalls(), 1);
});
