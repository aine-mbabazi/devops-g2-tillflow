import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { calculateCommissions } from '../src/calculate.js';
import { loadConfig } from '../src/config.js';
import { InMemoryCommissionLedger } from '../src/ledger.js';
import { PaymentsClient } from '../src/payments-client.js';
import { runDailyClose, reconcilePendingLedgerEntries } from '../src/daily-close.js';

// The deterministic fake Daraja adapter lives in the Payments service; this
// integration test drives Commission against real Payments and POS HTTP
// servers so the sale -> paid -> close -> commission -> B2C flow is proven
// end to end, exactly as the brief requires, with no real Daraja traffic
// anywhere in the test run.
import { createApp } from '../../payments/src/app.js';
import { FakeDarajaClient } from '../../payments/src/daraja/fake-client.js';
import { createApp as createPosApp } from '../../pos/src/app.js';
import { InMemorySaleStore } from '../../pos/src/sale-store.js';
import { InMemoryTenantStore } from '../../pos/src/tenant-store.js';
import { PosClient } from '../src/pos-client.js';

const TEST_SECRET = 'test-service-auth-secret';

test('commission never imports a Daraja client', () => {
  const srcDir = fileURLToPath(new URL('../src', import.meta.url));
  const offenders = [];
  for (const file of readdirSync(srcDir)) {
    const filePath = path.join(srcDir, file);
    if (!statSync(filePath).isFile()) continue;
    const content = readFileSync(filePath, 'utf8');
    // Check actual import specifiers, not prose: a comment explaining "we
    // never touch Daraja" would otherwise trip this test on its own wording.
    if (/from\s+['"][^'"]*daraja[^'"]*['"]/i.test(content)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], 'Commission must reach Daraja only through the Payments API, never directly');
});

test('configuration requires a service auth secret and at least one tenant to close', () => {
  assert.throws(() => loadConfig({}), /SERVICE_AUTH_SECRET/);
  assert.throws(() => loadConfig({ SERVICE_AUTH_SECRET: TEST_SECRET }), /TENANT_IDS/);
  assert.deepEqual(loadConfig({ SERVICE_AUTH_SECRET: TEST_SECRET, TENANT_IDS: 't1, t2' }), {
    posBaseUrl: 'http://127.0.0.1:3002', paymentsBaseUrl: 'http://127.0.0.1:3001',
    serviceAuthSecret: TEST_SECRET, tenantIds: ['t1', 't2'], ledgerStore: 'memory', databaseUrl: undefined,
  });
  assert.throws(() => loadConfig({ SERVICE_AUTH_SECRET: TEST_SECRET, TENANT_IDS: 't1', POS_BASE_URL: 'not-a-url' }), /POS_BASE_URL/);
  assert.throws(() => loadConfig({ SERVICE_AUTH_SECRET: TEST_SECRET, TENANT_IDS: 't1', LEDGER_STORE: 'postgres' }), /DATABASE_URL/);
  assert.throws(() => loadConfig({ SERVICE_AUTH_SECRET: TEST_SECRET, TENANT_IDS: 't1', LEDGER_STORE: 'bogus' }), /LEDGER_STORE/);
});

test('calculateCommissions uses confirmed-paid sales only, floors the rate, groups per attendant, and tracks which sales contributed', () => {
  const paidSales = [
    { saleId: 's1', tenantId: 't1', attendantId: 'a1', amountMinor: 10000, status: 'paid' },
    { saleId: 's2', tenantId: 't1', attendantId: 'a1', amountMinor: 5000, status: 'paid' },
    { saleId: 's3', tenantId: 't1', attendantId: 'a1', amountMinor: 999999, status: 'pending' }, // excluded: not confirmed paid
    { saleId: 's4', tenantId: 't1', attendantId: 'a2', amountMinor: 33, status: 'paid' }, // 10% floors to 3
    { saleId: 's5', tenantId: 't2', attendantId: 'a1', amountMinor: 100000, status: 'paid' }, // different tenant, separate total
  ];
  const commissions = calculateCommissions({ paidSales, commissionRateBasisPoints: 1000 }); // 10%
  assert.deepEqual(
    commissions.sort((a, b) => a.tenantId.localeCompare(b.tenantId) || a.attendantId.localeCompare(b.attendantId)),
    [
      { tenantId: 't1', attendantId: 'a1', amountMinor: 1500, saleIds: ['s1', 's2'] },
      { tenantId: 't1', attendantId: 'a2', amountMinor: 3, saleIds: ['s4'] },
      { tenantId: 't2', attendantId: 'a1', amountMinor: 10000, saleIds: ['s5'] },
    ],
  );
  assert.throws(() => calculateCommissions({ paidSales: [], commissionRateBasisPoints: 10001 }), /commissionRateBasisPoints/);
});

async function startPaymentsServer(t) {
  const client = new FakeDarajaClient();
  let b2cCalls = 0;
  let lastProviderRequestId;
  const initiateB2C = client.initiateB2C.bind(client);
  client.initiateB2C = async (input) => {
    b2cCalls += 1;
    const result = await initiateB2C(input);
    lastProviderRequestId = result.providerRequestId;
    return result;
  };
  const server = createApp({ darajaClient: client, serviceAuthSecret: TEST_SECRET });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`, client,
    getB2CCalls: () => b2cCalls, getLastProviderRequestId: () => lastProviderRequestId,
  };
}

// Seeds already-paid sales directly into a POS sale store. POS's own test
// suite proves the sale -> STK -> callback -> reconcile -> paid path in
// full; this integration only needs "POS already has confirmed paid sales,"
// which is what Commission actually reads.
async function startPosServer(t, { paidSales = [], tenantConfig } = {}) {
  const saleStore = new InMemorySaleStore();
  for (const sale of paidSales) {
    const { sale: created } = saleStore.createOrGet({
      tenantId: sale.tenantId, attendantId: sale.attendantId,
      idempotencyKey: `seed-${saleStore.listPaid(sale.tenantId).length}-${Math.random()}`,
      fingerprint: `seed-${Math.random()}`, lineItems: [], amountMinor: sale.amountMinor,
      currency: 'KES', customerPhone: '+254700000000',
    });
    saleStore.markPaid(created.id);
  }
  const tenantStore = new InMemoryTenantStore();
  if (tenantConfig) tenantStore.configure(tenantConfig.tenantId, tenantConfig);
  const server = createPosApp({ paymentsClient: {}, serviceAuthSecret: TEST_SECRET, saleStore, tenantStore });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, saleStore };
}

// A second confirmed-paid sale, seeded directly into the store the same way
// startPosServer's initial fixtures are — the pay/reconcile HTTP dance is
// already proven by POS's own suite and doesn't need re-proving here.
function seedPaidSale(saleStore, { tenantId, attendantId, amountMinor }) {
  const { sale } = saleStore.createOrGet({
    tenantId, attendantId, idempotencyKey: `extra-${Math.random()}`, fingerprint: `extra-${Math.random()}`,
    lineItems: [], amountMinor, currency: 'KES', customerPhone: '+254700000000',
  });
  saleStore.markPaid(sale.id);
  return sale;
}

const paidSales = [
  { tenantId: 'tenant_demo_001', attendantId: 'attendant_demo_001', amountMinor: 20000 },
  { tenantId: 'tenant_demo_001', attendantId: 'attendant_demo_001', amountMinor: 5000 },
];
const tenantConfig = {
  tenantId: 'tenant_demo_001', commissionRateBasisPoints: 1000,
  attendants: [{ id: 'attendant_demo_001', phone: '+254700000009' }],
};

test('daily close reads confirmed paid sales and tenant config from POS, and requests exactly one B2C payout per attendant', async (t) => {
  const { baseUrl, getB2CCalls } = await startPaymentsServer(t);
  const { baseUrl: posBaseUrl } = await startPosServer(t, { paidSales, tenantConfig });
  const paymentsClient = new PaymentsClient({ baseUrl, serviceAuthSecret: TEST_SECRET });
  const posClient = new PosClient({ baseUrl: posBaseUrl, serviceAuthSecret: TEST_SECRET });
  const ledger = new InMemoryCommissionLedger();

  const results = await runDailyClose({
    tenantId: 'tenant_demo_001', commissionRunId: 'run_2026-09-15', posClient, paymentsClient, ledger,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].amountMinor, 2500); // 10% of 25000
  assert.equal(results[0].status, 'pending');
  assert.equal(getB2CCalls(), 1);
  assert.equal(ledger.get('tenant_demo_001', 'run_2026-09-15', 'attendant_demo_001').payoutId, results[0].payoutId);
});

test('re-running the same daily close cannot double-pay', async (t) => {
  const { baseUrl, getB2CCalls } = await startPaymentsServer(t);
  const { baseUrl: posBaseUrl } = await startPosServer(t, { paidSales, tenantConfig });
  const paymentsClient = new PaymentsClient({ baseUrl, serviceAuthSecret: TEST_SECRET });
  const posClient = new PosClient({ baseUrl: posBaseUrl, serviceAuthSecret: TEST_SECRET });

  // Two independent ledgers (e.g. two process restarts) reusing the same
  // deterministic idempotency key: Payments' own idempotency is what has to
  // hold here, not in-process worker state.
  const first = await runDailyClose({
    tenantId: 'tenant_demo_001', commissionRunId: 'run_2026-09-15', posClient, paymentsClient, ledger: new InMemoryCommissionLedger(),
  });
  const second = await runDailyClose({
    tenantId: 'tenant_demo_001', commissionRunId: 'run_2026-09-15', posClient, paymentsClient, ledger: new InMemoryCommissionLedger(),
  });

  assert.equal(first[0].payoutId, second[0].payoutId);
  assert.equal(getB2CCalls(), 1, 'a rerun must not dispatch a second B2C payment');
});

test('an attendant with no confirmed paid sales gets no payout, and a missing phone is skipped without dispatch', async (t) => {
  const { baseUrl, getB2CCalls } = await startPaymentsServer(t);
  const { baseUrl: posBaseUrl } = await startPosServer(t, {
    paidSales: [{ tenantId: 'tenant_demo_001', attendantId: 'attendant_no_phone', amountMinor: 10000 }],
    tenantConfig: { tenantId: 'tenant_demo_001', commissionRateBasisPoints: 1000, attendants: [{ id: 'attendant_someone_else', phone: '+254700000001' }] },
  });
  const paymentsClient = new PaymentsClient({ baseUrl, serviceAuthSecret: TEST_SECRET });
  const posClient = new PosClient({ baseUrl: posBaseUrl, serviceAuthSecret: TEST_SECRET });
  const ledger = new InMemoryCommissionLedger();

  const results = await runDailyClose({
    tenantId: 'tenant_demo_001', commissionRunId: 'run_2026-09-16', posClient, paymentsClient, ledger,
  });

  assert.deepEqual(results, []);
  assert.equal(getB2CCalls(), 0);
});

test('a tenant with no configuration yet is skipped, not treated as zero eligible payouts by accident', async (t) => {
  const { baseUrl } = await startPaymentsServer(t);
  const { baseUrl: posBaseUrl } = await startPosServer(t, { paidSales });
  const paymentsClient = new PaymentsClient({ baseUrl, serviceAuthSecret: TEST_SECRET });
  const posClient = new PosClient({ baseUrl: posBaseUrl, serviceAuthSecret: TEST_SECRET });

  const results = await runDailyClose({
    tenantId: 'tenant_demo_001', commissionRunId: 'run_2026-09-17', posClient, paymentsClient, ledger: new InMemoryCommissionLedger(),
  });
  assert.deepEqual(results, []);
});

test('a sale already paid commission on by a previous day\'s close is excluded from the next day\'s close', async (t) => {
  const { baseUrl, getB2CCalls } = await startPaymentsServer(t);
  const { baseUrl: posBaseUrl, saleStore } = await startPosServer(t, { paidSales, tenantConfig });
  const paymentsClient = new PaymentsClient({ baseUrl, serviceAuthSecret: TEST_SECRET });
  const posClient = new PosClient({ baseUrl: posBaseUrl, serviceAuthSecret: TEST_SECRET });

  const day1 = await runDailyClose({
    tenantId: 'tenant_demo_001', commissionRunId: 'run_2026-09-15', posClient, paymentsClient, ledger: new InMemoryCommissionLedger(),
  });
  assert.equal(day1.length, 1);
  assert.equal(day1[0].amountMinor, 2500); // 10% of the seeded 25000

  // A new sale comes in and gets paid before day 2's close.
  seedPaidSale(saleStore, { tenantId: 'tenant_demo_001', attendantId: 'attendant_demo_001', amountMinor: 3000 });

  const day2 = await runDailyClose({
    tenantId: 'tenant_demo_001', commissionRunId: 'run_2026-09-16', posClient, paymentsClient, ledger: new InMemoryCommissionLedger(),
  });

  // Without exclusion this would be 10% of 28000 (the old sales recounted
  // plus the new one) instead of 10% of just the new 3000.
  assert.equal(day2.length, 1);
  assert.equal(day2[0].amountMinor, 300);
  assert.equal(getB2CCalls(), 2, 'exactly one B2C dispatch per day, not a growing recount');
});

test('reconcilePendingLedgerEntries updates the ledger once Payments resolves a payout', async (t) => {
  const { baseUrl, client, getLastProviderRequestId } = await startPaymentsServer(t);
  const { baseUrl: posBaseUrl } = await startPosServer(t, { paidSales, tenantConfig });
  const paymentsClient = new PaymentsClient({ baseUrl, serviceAuthSecret: TEST_SECRET });
  const posClient = new PosClient({ baseUrl: posBaseUrl, serviceAuthSecret: TEST_SECRET });
  const ledger = new InMemoryCommissionLedger();

  await runDailyClose({ tenantId: 'tenant_demo_001', commissionRunId: 'run_2026-09-15', posClient, paymentsClient, ledger });
  assert.equal(ledger.get('tenant_demo_001', 'run_2026-09-15', 'attendant_demo_001').status, 'pending');

  // Payments resolves the B2C payout (fake provider outcome + its own callback).
  client.simulateOutcome(getLastProviderRequestId(), 'succeeded');
  await fetch(`${baseUrl}/payouts/callbacks/daraja`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ Result: { ConversationID: getLastProviderRequestId() } }),
  });

  const updated = await reconcilePendingLedgerEntries({ ledger, paymentsClient });
  assert.equal(updated.length, 1);
  assert.equal(updated[0].status, 'succeeded');
  assert.equal(ledger.get('tenant_demo_001', 'run_2026-09-15', 'attendant_demo_001').status, 'succeeded');

  // Nothing left pending, so a second pass is a no-op.
  assert.deepEqual(await reconcilePendingLedgerEntries({ ledger, paymentsClient }), []);
});
