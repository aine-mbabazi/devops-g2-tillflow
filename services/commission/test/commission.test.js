import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { calculateCommissions } from '../src/calculate.js';
import { InMemoryCommissionLedger } from '../src/ledger.js';
import { PaymentsClient } from '../src/payments-client.js';
import { runDailyClose } from '../src/daily-close.js';

// The deterministic fake Daraja adapter lives in the Payments service; this
// integration test drives Commission against a real Payments HTTP server so
// the close -> commission -> B2C flow is proven end to end, exactly as the
// brief requires, with no real Daraja traffic anywhere in the test run.
import { createApp } from '../../payments/src/app.js';
import { FakeDarajaClient } from '../../payments/src/daraja/fake-client.js';

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

test('calculateCommissions uses confirmed-paid sales only, floors the rate, and groups per attendant', () => {
  const paidSales = [
    { tenantId: 't1', attendantId: 'a1', amountMinor: 10000, status: 'paid' },
    { tenantId: 't1', attendantId: 'a1', amountMinor: 5000, status: 'paid' },
    { tenantId: 't1', attendantId: 'a1', amountMinor: 999999, status: 'pending' }, // excluded: not confirmed paid
    { tenantId: 't1', attendantId: 'a2', amountMinor: 33, status: 'paid' }, // 10% floors to 3
    { tenantId: 't2', attendantId: 'a1', amountMinor: 100000, status: 'paid' }, // different tenant, separate total
  ];
  const commissions = calculateCommissions({ paidSales, commissionRateBasisPoints: 1000 }); // 10%
  assert.deepEqual(
    commissions.sort((a, b) => a.tenantId.localeCompare(b.tenantId) || a.attendantId.localeCompare(b.attendantId)),
    [
      { tenantId: 't1', attendantId: 'a1', amountMinor: 1500 },
      { tenantId: 't1', attendantId: 'a2', amountMinor: 3 },
      { tenantId: 't2', attendantId: 'a1', amountMinor: 10000 },
    ],
  );
  assert.throws(() => calculateCommissions({ paidSales: [], commissionRateBasisPoints: 10001 }), /commissionRateBasisPoints/);
});

async function startPaymentsServer(t) {
  const client = new FakeDarajaClient();
  let b2cCalls = 0;
  const initiateB2C = client.initiateB2C.bind(client);
  client.initiateB2C = async (input) => { b2cCalls += 1; return initiateB2C(input); };
  const server = createApp({ darajaClient: client });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, getB2CCalls: () => b2cCalls };
}

const paidSales = [
  { tenantId: 'tenant_demo_001', attendantId: 'attendant_demo_001', amountMinor: 20000, status: 'paid' },
  { tenantId: 'tenant_demo_001', attendantId: 'attendant_demo_001', amountMinor: 5000, status: 'paid' },
  { tenantId: 'tenant_demo_001', attendantId: 'attendant_demo_001', amountMinor: 999999, status: 'refunded' },
];
const attendantPhones = { attendant_demo_001: '+254700000009' };

test('daily close calculates from confirmed paid sales and requests exactly one B2C payout per attendant', async (t) => {
  const { baseUrl, getB2CCalls } = await startPaymentsServer(t);
  const paymentsClient = new PaymentsClient({ baseUrl });
  const ledger = new InMemoryCommissionLedger();

  const results = await runDailyClose({
    tenantId: 'tenant_demo_001', commissionRunId: 'run_2026-09-15', paidSales,
    commissionRateBasisPoints: 1000, attendantPhones, paymentsClient, ledger,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].amountMinor, 2500); // 10% of 25000
  assert.equal(results[0].status, 'pending');
  assert.equal(getB2CCalls(), 1);
  assert.equal(ledger.get('tenant_demo_001', 'run_2026-09-15', 'attendant_demo_001').payoutId, results[0].payoutId);
});

test('re-running the same daily close cannot double-pay', async (t) => {
  const { baseUrl, getB2CCalls } = await startPaymentsServer(t);
  const paymentsClient = new PaymentsClient({ baseUrl });

  // Two independent ledgers (e.g. two process restarts) reusing the same
  // deterministic idempotency key: Payments' own idempotency is what has to
  // hold here, not in-process worker state.
  const first = await runDailyClose({
    tenantId: 'tenant_demo_001', commissionRunId: 'run_2026-09-15', paidSales,
    commissionRateBasisPoints: 1000, attendantPhones, paymentsClient, ledger: new InMemoryCommissionLedger(),
  });
  const second = await runDailyClose({
    tenantId: 'tenant_demo_001', commissionRunId: 'run_2026-09-15', paidSales,
    commissionRateBasisPoints: 1000, attendantPhones, paymentsClient, ledger: new InMemoryCommissionLedger(),
  });

  assert.equal(first[0].payoutId, second[0].payoutId);
  assert.equal(getB2CCalls(), 1, 'a rerun must not dispatch a second B2C payment');
});

test('an attendant with no confirmed paid sales gets no payout, and a missing phone is skipped without dispatch', async (t) => {
  const { baseUrl, getB2CCalls } = await startPaymentsServer(t);
  const paymentsClient = new PaymentsClient({ baseUrl });
  const ledger = new InMemoryCommissionLedger();

  const results = await runDailyClose({
    tenantId: 'tenant_demo_001', commissionRunId: 'run_2026-09-16',
    paidSales: [{ tenantId: 'tenant_demo_001', attendantId: 'attendant_no_phone', amountMinor: 10000, status: 'paid' }],
    commissionRateBasisPoints: 1000, attendantPhones: {}, paymentsClient, ledger,
  });

  assert.deepEqual(results, []);
  assert.equal(getB2CCalls(), 0);
});
