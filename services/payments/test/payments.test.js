import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { FakeDarajaClient } from '../src/daraja/fake-client.js';

test('configuration defaults to local fake mode and rejects invalid settings', () => {
  assert.deepEqual(loadConfig({}), { host: '127.0.0.1', port: 3001, darajaMode: 'fake' });
  for (const port of ['0', '-1', '65536', '3001x', '1.5', '']) {
    assert.throws(() => loadConfig({ PORT: port }), /PORT/);
  }
  assert.throws(() => loadConfig({ DARAJA_MODE: 'production' }), /Only DARAJA_MODE=fake/);
  assert.throws(() => loadConfig({ HOST: '' }), /HOST/);
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
