#!/usr/bin/env node
// Game day drill 2 — Callback replay (docs/runbook.md#game-day-drills)
//
// Hypothesis: replayed and reordered callbacks produce exactly one legal
// transition and one ledger effect — a replay is a no-op, and a genuine
// conflict is logged, never silently applied.
//
// Drives the REAL app.js callback handler over real HTTP. app.js never
// trusts the callback body's claimed outcome — every callback re-verifies
// against darajaClient.queryPayment(checkoutRequestId) and only the
// verified result can move the stored status. That is what makes a
// "conflicting callback" reproducible here: a hand-rolled stub Daraja
// client (same pattern the unit tests already use for the timeout drill)
// is scripted to answer a *different* status on its third query, standing
// in for a stale/reordered real-world callback whose re-verification
// disagrees with what's already been recorded.
//
// Run: node evidence/reliability-operations/game-day/drill-02-callback-replay.mjs

import { once } from 'node:events';
import { createApp } from '../../../services/payments/src/app.js';
import { InMemoryPaymentStore } from '../../../services/payments/src/payment-store.js';
import { signServiceAuth } from '../../../services/_shared/service-auth.js';

const SECRET = 'drill-service-auth-secret';
const TENANT = 'tenant_drill_002';
const logLines = [];
function log(entry) {
  const line = { ts: new Date().toISOString(), ...entry };
  logLines.push(line);
  console.log(JSON.stringify(line));
}

function authHeader(tenantId) {
  return { 'x-service-auth': signServiceAuth(tenantId, SECRET) };
}

async function main() {
  const paymentStore = new InMemoryPaymentStore();
  const CHECKOUT_ID = 'ckid-drill-2';

  // Scripted provider responses: dispatch succeeds immediately (providerRequestId
  // assigned), then three queries — succeeded, succeeded again (the replay),
  // then failed (the reordered/conflicting one). Real Daraja would never
  // actually flip a terminal outcome; this stands in for a stale callback
  // whose re-verification races a more recent one, which is the reordering
  // case the drill exists to prove is handled safely.
  const scriptedQueryResults = ['succeeded', 'succeeded', 'failed'];
  let queryCalls = 0;
  const client = {
    async initiateStkPush() { return { providerRequestId: CHECKOUT_ID, status: 'pending' }; },
    async queryPayment(id) {
      const status = scriptedQueryResults[Math.min(queryCalls, scriptedQueryResults.length - 1)];
      queryCalls += 1;
      return { providerRequestId: id, status };
    },
  };

  const server = createApp({ darajaClient: client, serviceAuthSecret: SECRET, paymentStore, log });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  log({ event: 'drill_started', drill: 'callback-replay', base });

  const sale = {
    tenant_id: TENANT, sale_id: 'sale_drill_002', amount_minor: 80000,
    currency: 'KES', customer_phone: '+254700000098',
  };

  const created = await fetch(`${base}/payments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'drill-2-key', ...authHeader(TENANT) },
    body: JSON.stringify(sale),
  });
  const payment = await created.json();
  assertEqual(created.status, 202, 'POST /payments status');
  assertEqual(payment.status, 'pending', 'payment starts pending');

  function postCallback() {
    return fetch(`${base}/payments/callbacks/daraja`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ Body: { stkCallback: { CheckoutRequestID: CHECKOUT_ID } } }),
    });
  }
  function countEvents(event) { return logLines.filter((l) => l.event === event).length; }

  // Step 1: the original, terminal callback.
  log({ event: 'drill_step', step: 1, description: 'POST the original terminal callback (verified: succeeded)' });
  const original = await postCallback();
  const originalBody = await original.json();
  assertEqual(original.status, 200, 'original callback status');
  assertEqual(originalBody.status, 'succeeded', 'payment transitions to succeeded');
  assertEqual(countEvents('callback_processed'), 1, 'exactly one callback_processed logged so far');
  assertEqual(countEvents('callback_conflict'), 0, 'no conflict on the original callback');
  log({ event: 'drill_assertion', step: 1, result: 'pass', detail: 'one legal transition, one callback_processed' });

  // Step 2: replay the identical callback.
  log({ event: 'drill_step', step: 2, description: 'Replay the identical callback (re-verifies as: succeeded, unchanged)' });
  const replay = await postCallback();
  const replayBody = await replay.json();
  assertEqual(replay.status, 200, 'replayed callback status');
  assertEqual(replayBody.status, 'succeeded', 'status unchanged by the replay');
  assertEqual(countEvents('callback_processed'), 1, 'replay produced NO second callback_processed — a true no-op');
  assertEqual(countEvents('callback_conflict'), 0, 'a same-status replay is not a conflict');
  assertEqual(paymentStore.findById(payment.payment_id).status, 'succeeded', 'stored state unchanged by the replay');
  log({ event: 'drill_assertion', step: 2, result: 'pass', detail: 'replay was a no-op: still exactly one callback_processed, ledger effect not repeated' });

  // Step 3: a reordered/conflicting callback — re-verification now disagrees
  // with the already-recorded terminal status.
  log({ event: 'drill_step', step: 3, description: 'POST a reordered callback whose re-verification now disagrees (verified: failed)' });
  const conflicting = await postCallback();
  const conflictingBody = await conflicting.json();
  assertEqual(conflicting.status, 200, 'conflicting callback still returns 200 (no error surfaced to Daraja)');
  assertEqual(conflictingBody.status, 'succeeded', 'the response reflects the ledger, which did not move');
  assertEqual(countEvents('callback_conflict'), 1, 'the disagreement was logged as callback_conflict');
  const conflictLog = logLines.find((l) => l.event === 'callback_conflict');
  assertEqual(conflictLog.storedStatus, 'succeeded', 'conflict log records what was stored');
  assertEqual(conflictLog.verifiedStatus, 'failed', 'conflict log records what the reordered callback verified');
  assertEqual(countEvents('callback_processed'), 1, 'the conflict did not produce a second ledger effect');
  assertEqual(paymentStore.findById(payment.payment_id).status, 'succeeded', 'stored state is UNCHANGED by the conflicting callback');
  log({ event: 'drill_assertion', step: 3, result: 'pass', detail: 'conflict logged with both statuses; stored state untouched — one ledger effect for the whole drill' });

  server.close();
  server.closeAllConnections?.();
  log({ event: 'drill_completed', drill: 'callback-replay', result: 'pass' });
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    log({ event: 'drill_assertion', result: 'fail', message, actual, expected });
    console.error(`DRILL FAILED: ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('DRILL FAILED WITH EXCEPTION', error);
  process.exit(1);
});
