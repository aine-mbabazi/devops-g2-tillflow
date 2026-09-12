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
  const missing = await fetch(`${base}/payments`, { method: 'POST' });
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
