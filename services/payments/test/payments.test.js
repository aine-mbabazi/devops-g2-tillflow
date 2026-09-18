import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { FakeDarajaClient } from '../src/daraja/fake-client.js';
import { DarajaSandboxClient } from '../src/daraja/sandbox-client.js';
import { InMemoryPaymentStore } from '../src/payment-store.js';
import { signServiceAuth } from '../../_shared/service-auth.js';

const TEST_SECRET = 'test-service-auth-secret';
function authHeader(tenantId) {
  return { 'x-service-auth': signServiceAuth(tenantId, TEST_SECRET) };
}

test('configuration defaults to local fake mode and rejects invalid settings', () => {
  assert.throws(() => loadConfig({}), /SERVICE_AUTH_SECRET/);
  assert.deepEqual(loadConfig({ SERVICE_AUTH_SECRET: TEST_SECRET }), {
    host: '127.0.0.1', port: 3001, darajaMode: 'fake', paymentStore: 'memory', databaseUrl: undefined, serviceAuthSecret: TEST_SECRET,
    sandbox: {
      consumerKey: undefined, consumerSecret: undefined, shortcode: undefined, passkey: undefined, callbackUrl: undefined, timeoutMs: 10000,
      b2cShortcode: undefined, b2cInitiatorName: undefined, b2cSecurityCredential: undefined, b2cResultUrl: undefined, b2cTimeoutUrl: undefined,
    },
  });
  for (const port of ['0', '-1', '65536', '3001x', '1.5', '']) {
    assert.throws(() => loadConfig({ PORT: port, SERVICE_AUTH_SECRET: TEST_SECRET }), /PORT/);
  }
  assert.throws(() => loadConfig({ DARAJA_MODE: 'production', SERVICE_AUTH_SECRET: TEST_SECRET }), /DARAJA_MODE/);
  assert.throws(() => loadConfig({ HOST: '', SERVICE_AUTH_SECRET: TEST_SECRET }), /HOST/);
  assert.throws(() => loadConfig({ PAYMENT_STORE: 'postgres', SERVICE_AUTH_SECRET: TEST_SECRET }), /DATABASE_URL/);
  assert.throws(() => loadConfig({ PAYMENT_STORE: 'unknown', SERVICE_AUTH_SECRET: TEST_SECRET }), /PAYMENT_STORE/);
  assert.throws(() => loadConfig({ DARAJA_MODE: 'sandbox', SERVICE_AUTH_SECRET: TEST_SECRET }), /credentials/);
  const sandboxEnv = {
    DARAJA_MODE: 'sandbox', DARAJA_CONSUMER_KEY: 'key', DARAJA_CONSUMER_SECRET: 'secret', SERVICE_AUTH_SECRET: TEST_SECRET,
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

test('service-auth tokens verify only when correctly signed, fresh, and unmodified', async () => {
  const { verifyServiceAuth } = await import('../../_shared/service-auth.js');
  const token = signServiceAuth('tenant_demo_001', TEST_SECRET, () => 1_000_000);
  assert.deepEqual(verifyServiceAuth(token, TEST_SECRET, () => 1_000_000), { tenantId: 'tenant_demo_001' });
  assert.equal(verifyServiceAuth(token, 'wrong-secret', () => 1_000_000), null);
  assert.equal(verifyServiceAuth('garbage', TEST_SECRET, () => 1_000_000), null);
  assert.equal(verifyServiceAuth(undefined, TEST_SECRET, () => 1_000_000), null);
  // A tampered tenant ID must not verify even though the rest of the token is untouched.
  const [, timestamp, signature] = token.split('.');
  assert.equal(verifyServiceAuth(`other_tenant.${timestamp}.${signature}`, TEST_SECRET, () => 1_000_000), null);
  // Six minutes later is outside the 5-minute freshness window.
  assert.equal(verifyServiceAuth(token, TEST_SECRET, () => 1_000_000 + 6 * 60 * 1000), null);
});

test('HTTP health works; payment routes are not exposed and logs omit query data', async (t) => {
  const entries = [];
  const server = createApp({ darajaClient: new FakeDarajaClient(), serviceAuthSecret: TEST_SECRET, log: (entry) => entries.push(entry) });
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

test('readiness reports the dependency, health does not', async (t) => {
  let storeReachable = true;
  const store = new InMemoryPaymentStore();
  store.ping = () => { if (!storeReachable) throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' }); };
  const entries = [];
  const server = createApp({ darajaClient: new FakeDarajaClient(), serviceAuthSecret: TEST_SECRET, paymentStore: store, log: (entry) => entries.push(entry) });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  // Unauthenticated on purpose: the load balancer and the synthetic probe both
  // call these without credentials, so they must not sit behind service auth.
  const ready = await fetch(`${base}/ready`);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { service: 'payments', status: 'ready' });

  storeReachable = false;
  const notReady = await fetch(`${base}/ready`);
  assert.equal(notReady.status, 503);
  assert.deepEqual(await notReady.json(), { service: 'payments', status: 'not_ready' });

  // Liveness must stay green while readiness is red, otherwise a database blip
  // restarts every task instead of draining traffic.
  assert.equal((await fetch(`${base}/health`)).status, 200);

  const head = await fetch(`${base}/ready`, { method: 'HEAD' });
  assert.equal(head.status, 503);
  assert.equal(await head.text(), '');

  const post = await fetch(`${base}/ready`, { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');

  assert.ok(entries.some((entry) => entry.event === 'readiness_check_failed' && entry.code === 'ECONNREFUSED'));
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
  const server = createApp({ darajaClient: client, serviceAuthSecret: TEST_SECRET, log: (entry) => entries.push(entry) });
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

function requestPayment(base, body, key = 'payment-request-001', authTenantId = body.tenant_id) {
  return fetch(`${base}/payments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key, ...authHeader(authTenantId) },
    body: JSON.stringify(body),
  });
}

function getPayment(base, id, tenantId) {
  return fetch(`${base}/payments/${id}`, { headers: { ...authHeader(tenantId) } });
}

function postCallback(base, checkoutRequestId) {
  return fetch(`${base}/payments/callbacks/daraja`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ Body: { stkCallback: { CheckoutRequestID: checkoutRequestId } } }),
  });
}

function requestPayout(base, body, key = 'payout-request-001', authTenantId = body.tenant_id) {
  return fetch(`${base}/payouts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key, ...authHeader(authTenantId) },
    body: JSON.stringify(body),
  });
}

function getPayout(base, id, tenantId) {
  return fetch(`${base}/payouts/${id}`, { headers: { ...authHeader(tenantId) } });
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
  const fetched = await getPayment(base, payment.payment_id, 'tenant_demo_001');
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

test('a tenant ID in the request body alone is not authorization', async (t) => {
  const { base } = await startPayments(t);
  const unauthenticated = await fetch(`${base}/payments`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'k1' }, body: JSON.stringify(validPayment),
  });
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(await unauthenticated.json(), { error: 'unauthenticated' });

  const forgedSignature = await fetch(`${base}/payments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'k2', 'x-service-auth': 'tenant_demo_001.0.not-a-real-signature' },
    body: JSON.stringify(validPayment),
  });
  assert.equal(forgedSignature.status, 401);

  // Authenticated as a different tenant than the body claims: the signed
  // identity wins, not the body.
  const mismatched = await requestPayment(base, validPayment, 'k3', 'a-different-tenant');
  assert.equal(mismatched.status, 403);
  assert.deepEqual(await mismatched.json(), { error: 'tenant_mismatch' });
});

test('a payment cannot be read by a tenant other than its own, without revealing whether it exists', async (t) => {
  const { base } = await startPayments(t);
  const created = await (await requestPayment(base, validPayment)).json();

  const noAuth = await fetch(`${base}/payments/${created.payment_id}`);
  assert.equal(noAuth.status, 401);

  const crossTenant = await getPayment(base, created.payment_id, 'a-different-tenant');
  assert.equal(crossTenant.status, 404);

  const unknownIdSameShape = await getPayment(base, 'payment_does-not-exist', 'a-different-tenant');
  assert.equal(unknownIdSameShape.status, 404);
  assert.deepEqual(await unknownIdSameShape.json(), await crossTenant.json());

  const ownTenant = await getPayment(base, created.payment_id, 'tenant_demo_001');
  assert.equal(ownTenant.status, 200);
});

test('a verified Daraja callback transitions a pending payment to succeeded or failed', async (t) => {
  const { base, client, getLastProviderRequestId } = await startPayments(t);
  const created = await (await requestPayment(base, validPayment)).json();
  const providerRequestId = getLastProviderRequestId();

  client.simulateOutcome(providerRequestId, 'succeeded');
  const response = await postCallback(base, providerRequestId);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ...created, status: 'succeeded' });

  const fetched = await getPayment(base, created.payment_id, 'tenant_demo_001');
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

  const fetched = await getPayment(base, created.payment_id, 'tenant_demo_001');
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

test('a terminal callback logs the lag the Payments SLI is measured from, once per payment', async (t) => {
  const { base, client, getLastProviderRequestId, entries } = await startPayments(t);
  await requestPayment(base, validPayment);
  const providerRequestId = getLastProviderRequestId();
  client.simulateOutcome(providerRequestId, 'succeeded');

  assert.equal((await postCallback(base, providerRequestId)).status, 200);
  const processed = entries.filter((entry) => entry.event === 'callback_processed');
  assert.equal(processed.length, 1);
  assert.equal(processed[0].status, 'succeeded');
  assert.ok(Number.isFinite(processed[0].callbackLagMs), 'callbackLagMs must be a number the metric filter can extract');
  assert.ok(processed[0].callbackLagMs >= 0);

  // A replayed callback must NOT emit a second event. The metric filter behind
  // devops-g2-payments-callback-lag would read the replay's age as a genuine
  // breach, so a callback replayed an hour later would page the on-call for a
  // payment that was actually processed instantly.
  entries.length = 0;
  assert.equal((await postCallback(base, providerRequestId)).status, 200);
  assert.ok(!entries.some((entry) => entry.event === 'callback_processed'));
});

test('payout callbacks feed the same lag metric as payments', async (t) => {
  const { base, client, getLastB2CProviderRequestId, entries } = await startPayments(t);
  await requestPayout(base, validPayout);
  const providerRequestId = getLastB2CProviderRequestId();
  client.simulateOutcome(providerRequestId, 'succeeded');

  assert.equal((await postPayoutCallback(base, providerRequestId)).status, 200);
  const processed = entries.filter((entry) => entry.event === 'callback_processed');
  assert.equal(processed.length, 1);
  assert.ok(processed[0].payoutId.startsWith('payout_'));
  assert.ok(Number.isFinite(processed[0].callbackLagMs));
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

test('payouts enforce the same service-auth boundary as payments', async (t) => {
  const { base } = await startPayments(t);
  const unauthenticated = await fetch(`${base}/payouts`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'k1' }, body: JSON.stringify(validPayout),
  });
  assert.equal(unauthenticated.status, 401);

  const mismatched = await requestPayout(base, validPayout, 'k2', 'a-different-tenant');
  assert.equal(mismatched.status, 403);
  assert.deepEqual(await mismatched.json(), { error: 'tenant_mismatch' });

  const created = await (await requestPayout(base, validPayout)).json();
  const crossTenant = await getPayout(base, created.payout_id, 'a-different-tenant');
  assert.equal(crossTenant.status, 404);
  const ownTenant = await getPayout(base, created.payout_id, 'tenant_demo_001');
  assert.equal(ownTenant.status, 200);
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
  const fetched = await getPayout(base, payout.payout_id, 'tenant_demo_001');
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
  assert.equal((await (await getPayout(base, created.payout_id, 'tenant_demo_001')).json()).status, 'pending');

  const unknown = await postPayoutCallback(base, 'unknown-conversation-id');
  assert.equal(unknown.status, 404);

  const malformed = await fetch(`${base}/payouts/callbacks/daraja`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ unexpected: true }),
  });
  assert.equal(malformed.status, 400);
});
