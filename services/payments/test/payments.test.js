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
    sandbox: {
      consumerKey: undefined, consumerSecret: undefined, shortcode: undefined, passkey: undefined, callbackUrl: undefined, timeoutMs: 10000,
      b2cShortcode: undefined, b2cInitiatorName: undefined, b2cSecurityCredential: undefined, b2cResultUrl: undefined, b2cTimeoutUrl: undefined,
    },
  });
  for (const port of ['0', '-1', '65536', '3001x', '1.5', '']) {
    assert.throws(() => loadConfig({ PORT: port }), /PORT/);
  }
  assert.throws(() => loadConfig({ DARAJA_MODE: 'production' }), /DARAJA_MODE/);
  assert.throws(() => loadConfig({ HOST: '' }), /HOST/);
  assert.throws(() => loadConfig({ PAYMENT_STORE: 'postgres' }), /DATABASE_URL/);
  assert.throws(() => loadConfig({ PAYMENT_STORE: 'unknown' }), /PAYMENT_STORE/);
  assert.throws(() => loadConfig({ DARAJA_MODE: 'sandbox' }), /credentials/);
  const sandboxEnv = {
    DARAJA_MODE: 'sandbox', DARAJA_CONSUMER_KEY: 'key', DARAJA_CONSUMER_SECRET: 'secret',
    DARAJA_STK_SHORTCODE: '174379', DARAJA_STK_PASSKEY: 'passkey', DARAJA_STK_CALLBACK_URL: 'https://example.test/callback',
    DARAJA_B2C_SHORTCODE: '600000', DARAJA_B2C_INITIATOR_NAME: 'testapi', DARAJA_B2C_SECURITY_CREDENTIAL: 'cred',
    DARAJA_B2C_RESULT_URL: 'https://example.test/b2c/result', DARAJA_B2C_TIMEOUT_URL: 'https://example.test/b2c/timeout',
  };
  assert.throws(() => loadConfig({ ...sandboxEnv, DARAJA_STK_CALLBACK_URL: 'http://example.test/callback' }), /HTTPS/);
  assert.throws(() => loadConfig({ ...sandboxEnv, DARAJA_STK_SHORTCODE: 'x' }), /numeric/);
  assert.throws(() => loadConfig({ ...sandboxEnv, DARAJA_B2C_SHORTCODE: 'x' }), /DARAJA_B2C_SHORTCODE/);
  assert.throws(() => loadConfig({ ...sandboxEnv, DARAJA_B2C_RESULT_URL: 'http://example.test/b2c/result' }), /DARAJA_B2C_RESULT_URL/);
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

test('Daraja sandbox client sends a B2C payment request and queries transaction status for reconciliation', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.includes('/oauth/')) return new Response(JSON.stringify({ access_token: 'sandbox-token' }), { status: 200 });
    if (url.includes('/b2c/v1/paymentrequest')) return new Response(JSON.stringify({ ConversationID: 'AG_20260102_conv123' }), { status: 200 });
    return new Response(JSON.stringify({ ResultCode: '0' }), { status: 200 });
  };
  const client = new DarajaSandboxClient({
    consumerKey: 'key', consumerSecret: 'secret', shortcode: '174379', passkey: 'passkey', callbackUrl: 'https://example.test/callback',
    b2cShortcode: '600000', b2cInitiatorName: 'testapi', b2cSecurityCredential: 'cred',
    b2cResultUrl: 'https://example.test/b2c/result', b2cTimeoutUrl: 'https://example.test/b2c/timeout',
    fetchImpl, now: () => new Date('2026-01-02T00:04:05Z'),
  });
  const result = await client.initiateB2C({ amountMinor: 10000, currency: 'KES', phone: '+254700000001', reference: 'payout_demo_001' });
  assert.deepEqual(result, { providerRequestId: 'AG_20260102_conv123', status: 'pending' });
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.Amount, 100);
  assert.equal(body.PartyB, '254700000001');
  assert.equal(body.PartyA, '600000');
  assert.equal(body.CommandID, 'BusinessPayment');
  await assert.rejects(client.initiateB2C({ amountMinor: 101, currency: 'KES', phone: '+254700000001', reference: 'x' }), /whole KES/);

  const status = await client.queryB2C('AG_20260102_conv123');
  assert.deepEqual(status, { providerRequestId: 'AG_20260102_conv123', status: 'succeeded' });
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

test('fake client B2C payouts follow the same pending/query/simulate lifecycle as STK', async () => {
  const client = new FakeDarajaClient();
  const payout = await client.initiateB2C({ amountMinor: 5000, currency: 'KES', phone: 'synthetic-attendant-phone' });
  assert.match(payout.providerRequestId, /^fake-b2c-/);
  assert.equal(payout.status, 'pending');
  client.simulateOutcome(payout.providerRequestId, 'succeeded');
  assert.equal((await client.queryB2C(payout.providerRequestId)).status, 'succeeded');
  await assert.rejects(client.initiateB2C({ amountMinor: -1, currency: 'KES', phone: 'x' }), /amountMinor/);
});

async function startPayments(t) {
  const client = new FakeDarajaClient();
  let calls = 0;
  let lastProviderRequestId;
  const initiate = client.initiateStkPush.bind(client);
  client.initiateStkPush = async (input) => {
    calls += 1;
    const result = await initiate(input);
    lastProviderRequestId = result.providerRequestId;
    return result;
  };
  let b2cCalls = 0;
  let lastB2CProviderRequestId;
  const initiateB2C = client.initiateB2C.bind(client);
  client.initiateB2C = async (input) => {
    b2cCalls += 1;
    const result = await initiateB2C(input);
    lastB2CProviderRequestId = result.providerRequestId;
    return result;
  };
  const entries = [];
  const server = createApp({ darajaClient: client, log: (entry) => entries.push(entry) });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    getCalls: () => calls,
    getLastProviderRequestId: () => lastProviderRequestId,
    getB2CCalls: () => b2cCalls,
    getLastB2CProviderRequestId: () => lastB2CProviderRequestId,
    client,
    entries,
  };
}

function requestPayment(base, body, key = 'payment-request-001') {
  return fetch(`${base}/payments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  });
}

function postCallback(base, checkoutRequestId) {
  return fetch(`${base}/payments/callbacks/daraja`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ Body: { stkCallback: { CheckoutRequestID: checkoutRequestId } } }),
  });
}

function requestPayout(base, body, key = 'payout-request-001') {
  return fetch(`${base}/payouts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  });
}

function postPayoutCallback(base, conversationId) {
  return fetch(`${base}/payouts/callbacks/daraja`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ Result: { ConversationID: conversationId } }),
  });
}

const validPayout = {
  tenant_id: 'tenant_demo_001', attendant_id: 'attendant_demo_001', commission_run_id: 'commission_run_demo_001',
  amount_minor: 2500, currency: 'KES', recipient_phone: '+254700000002',
};

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

test('a verified Daraja callback transitions a pending payment to succeeded or failed', async (t) => {
  const { base, client, getLastProviderRequestId } = await startPayments(t);
  const created = await (await requestPayment(base, validPayment)).json();
  const providerRequestId = getLastProviderRequestId();

  client.simulateOutcome(providerRequestId, 'succeeded');
  const response = await postCallback(base, providerRequestId);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ...created, status: 'succeeded' });

  const fetched = await fetch(`${base}/payments/${created.payment_id}`);
  assert.equal((await fetched.json()).status, 'succeeded');
});

test('callback verification failure leaves the payment pending for later reconciliation', async (t) => {
  const { base, getLastProviderRequestId } = await startPayments(t);
  const created = await (await requestPayment(base, validPayment)).json();
  const providerRequestId = getLastProviderRequestId();

  // The fake client's stored outcome is still 'pending' by default, so query returns pending.
  const response = await postCallback(base, providerRequestId);
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { status: 'pending' });

  const fetched = await fetch(`${base}/payments/${created.payment_id}`);
  assert.equal((await fetched.json()).status, 'pending');
});

test('a callback for an unknown provider request id is rejected without leaking state', async (t) => {
  const { base } = await startPayments(t);
  const response = await postCallback(base, 'unknown-checkout-id');
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'not_found' });
});

test('a malformed callback body is rejected before any lookup', async (t) => {
  const { base } = await startPayments(t);
  const response = await fetch(`${base}/payments/callbacks/daraja`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ unexpected: true }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'invalid_callback' });
});

test('replaying a callback after a terminal result is a no-op', async (t) => {
  const { base, client, getLastProviderRequestId, entries } = await startPayments(t);
  await requestPayment(base, validPayment);
  const providerRequestId = getLastProviderRequestId();
  client.simulateOutcome(providerRequestId, 'succeeded');

  assert.equal((await postCallback(base, providerRequestId)).status, 200);
  entries.length = 0;
  const replay = await postCallback(base, providerRequestId);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).status, 'succeeded');
  assert.ok(!entries.some((entry) => entry.event === 'callback_conflict'));
});

test('a callback reporting an outcome that conflicts with the stored terminal state is preserved and flagged', async (t) => {
  const { base, client, getLastProviderRequestId, entries } = await startPayments(t);
  await requestPayment(base, validPayment);
  const providerRequestId = getLastProviderRequestId();
  client.simulateOutcome(providerRequestId, 'succeeded');
  assert.equal((await postCallback(base, providerRequestId)).status, 200);

  client.queryPayment = async () => ({ providerRequestId, status: 'failed' });
  const conflicting = await postCallback(base, providerRequestId);
  assert.equal(conflicting.status, 200);
  assert.equal((await conflicting.json()).status, 'succeeded');
  assert.ok(entries.some((entry) => entry.event === 'callback_conflict'
    && entry.storedStatus === 'succeeded' && entry.verifiedStatus === 'failed'));
});

test('creates and returns a pending payout attempt, dispatched via B2C', async (t) => {
  const { base, getB2CCalls } = await startPayments(t);
  const created = await requestPayout(base, validPayout);
  assert.equal(created.status, 202);
  const payout = await created.json();
  assert.match(payout.payout_id, /^payout_/);
  assert.deepEqual({ ...payout, payout_id: 'ignored' }, {
    payout_id: 'ignored', tenant_id: 'tenant_demo_001', attendant_id: 'attendant_demo_001',
    commission_run_id: 'commission_run_demo_001', amount_minor: 2500, currency: 'KES', status: 'pending',
  });
  assert.equal(getB2CCalls(), 1);
  const fetched = await fetch(`${base}/payouts/${payout.payout_id}`);
  assert.equal(fetched.status, 200);
  assert.deepEqual(await fetched.json(), payout);
});

test('returns the same payout for an identical retry without a second B2C dispatch', async (t) => {
  const { base, getB2CCalls } = await startPayments(t);
  const first = await requestPayout(base, validPayout);
  const original = await first.json();
  const retry = await requestPayout(base, validPayout);
  assert.equal(retry.status, 202);
  assert.deepEqual(await retry.json(), original);
  assert.equal(getB2CCalls(), 1);
});

test('rejects changed idempotency input and a second payout for the same ledger item', async (t) => {
  const { base, getB2CCalls } = await startPayments(t);
  assert.equal((await requestPayout(base, validPayout)).status, 202);
  const changed = await requestPayout(base, { ...validPayout, amount_minor: 5000 });
  assert.equal(changed.status, 409);
  assert.deepEqual(await changed.json(), { error: 'idempotency_key_reused' });
  // A daily-close rerun reusing a different key for the same (tenant, run, attendant) must not pay twice.
  const rerun = await requestPayout(base, validPayout, 'payout-request-002');
  assert.equal(rerun.status, 409);
  assert.deepEqual(await rerun.json(), { error: 'payout_already_exists' });
  const invalid = await requestPayout(base, { ...validPayout, recipient_phone: '0700000002' }, 'payout-request-003');
  assert.equal(invalid.status, 400);
  assert.equal(getB2CCalls(), 1);
});

test('a verified Daraja callback transitions a pending payout to succeeded, and replay/conflict are handled the same as payments', async (t) => {
  const { base, client, getLastB2CProviderRequestId, entries } = await startPayments(t);
  const created = await (await requestPayout(base, validPayout)).json();
  const providerRequestId = getLastB2CProviderRequestId();

  client.simulateOutcome(providerRequestId, 'succeeded');
  const response = await postPayoutCallback(base, providerRequestId);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ...created, status: 'succeeded' });

  entries.length = 0;
  const replay = await postPayoutCallback(base, providerRequestId);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).status, 'succeeded');
  assert.ok(!entries.some((entry) => entry.event === 'callback_conflict'));

  client.queryB2C = async () => ({ providerRequestId, status: 'failed' });
  const conflicting = await postPayoutCallback(base, providerRequestId);
  assert.equal((await conflicting.json()).status, 'succeeded');
  assert.ok(entries.some((entry) => entry.event === 'callback_conflict'
    && entry.storedStatus === 'succeeded' && entry.verifiedStatus === 'failed'));
});

test('payout callback verification failure leaves it pending; unknown/malformed callbacks are rejected', async (t) => {
  const { base, getLastB2CProviderRequestId } = await startPayments(t);
  const created = await (await requestPayout(base, validPayout)).json();
  const providerRequestId = getLastB2CProviderRequestId();

  const pending = await postPayoutCallback(base, providerRequestId);
  assert.equal(pending.status, 202);
  assert.deepEqual(await pending.json(), { status: 'pending' });
  assert.equal((await (await fetch(`${base}/payouts/${created.payout_id}`)).json()).status, 'pending');

  const unknown = await postPayoutCallback(base, 'unknown-conversation-id');
  assert.equal(unknown.status, 404);

  const malformed = await fetch(`${base}/payouts/callbacks/daraja`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ unexpected: true }),
  });
  assert.equal(malformed.status, 400);
});
