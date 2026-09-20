#!/usr/bin/env node
// Game day drill 1 — Uncertain payment (docs/runbook.md#game-day-drills)
//
// Hypothesis: a Daraja dispatch timeout leaves the payment pending, never
// declined; a retry with the same idempotency key cannot create a second
// charge; and the record is eventually moved to a terminal state without
// ever guessing at an outcome the provider hasn't confirmed.
//
// This drills the REAL app.js/payment-store.js/reconciliation-queue.js code
// paths over real HTTP, against a real (ephemeral) server — the only thing
// replaced is the Daraja transport itself (DARAJA_MODE=fake is the project's
// own deterministic-adapter rule; this is that adapter, forced into its
// timeout branch on demand).
//
// Run: node evidence/reliability-operations/game-day/drill-01-uncertain-payment.mjs
//
// Honest caveat, confirmed by reading reconciliation-queue.js#processMessage:
// a dispatch that times out before Daraja ever returns a provider ID has NO
// ID to query — processMessage's `if (!record.providerRequestId) return
// false` guard means the automated reconciler can never resolve it by itself.
// That is not a bug; it is why the DLQ / "query Daraja directly" step exists
// in docs/runbook.md#reconciliation-dlq. Step 5 below plays that human step:
// an operator confirms the true outcome out-of-band and resolves the record
// through the same store.transition() primitive the automated reconciler
// itself uses once it has a confirmed answer — never inferring one from the
// timeout.

import { once } from 'node:events';
import { createApp } from '../../../services/payments/src/app.js';
import { FakeDarajaClient } from '../../../services/payments/src/daraja/fake-client.js';
import { InMemoryPaymentStore } from '../../../services/payments/src/payment-store.js';
import { createReconciliationQueue } from '../../../services/payments/src/reconciliation-queue.js';
import { signServiceAuth } from '../../../services/_shared/service-auth.js';

const SECRET = 'drill-service-auth-secret';
const TENANT = 'tenant_drill_001';
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
  const realFakeClient = new FakeDarajaClient();

  // The transport double: throws DARAJA_TIMEOUT on the FIRST dispatch only,
  // exactly like the real sandbox client does when Safaricom never answers
  // (services/payments/src/daraja/sandbox-client.js). If idempotency is
  // broken and a retry ever re-dispatches, this would let call #2 succeed
  // silently — so leaving it wired through to the real fake client (instead
  // of always throwing) makes the drill fail loudly if that ever regresses.
  let dispatchCalls = 0;
  const client = {
    async initiateStkPush(input) {
      dispatchCalls += 1;
      if (dispatchCalls === 1) {
        const err = new Error('sandbox did not respond before the client timeout');
        err.code = 'DARAJA_TIMEOUT';
        throw err;
      }
      return realFakeClient.initiateStkPush(input);
    },
    queryPayment: (id) => realFakeClient.queryPayment(id),
    initiateB2C: (input) => realFakeClient.initiateB2C(input),
    queryB2C: (id) => realFakeClient.queryB2C(id),
  };

  const enqueued = [];
  const reconciliationQueue = { enqueue: async (message) => { enqueued.push(message); } };
  const { processMessage } = createReconciliationQueue({ queueClient: null, queueUrl: null, log });

  const server = createApp({ darajaClient: client, serviceAuthSecret: SECRET, paymentStore, log, reconciliationQueue });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  log({ event: 'drill_started', drill: 'uncertain-payment', base });

  const sale = {
    tenant_id: TENANT, sale_id: 'sale_drill_001', amount_minor: 150000,
    currency: 'KES', customer_phone: '+254700000099',
  };

  // Step 1: force the dispatch timeout.
  log({ event: 'drill_step', step: 1, description: 'POST /payments — force a Daraja dispatch timeout' });
  const first = await fetch(`${base}/payments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'drill-1-key', ...authHeader(TENANT) },
    body: JSON.stringify(sale),
  });
  const firstBody = await first.json();
  assertEqual(first.status, 202, 'first POST /payments status');
  assertEqual(firstBody.status, 'pending', 'payment stays pending after a timeout, never declined');
  assertEqual(dispatchCalls, 1, 'exactly one dispatch attempt so far');
  assertEqual(enqueued.length, 1, 'exactly one message enqueued for reconciliation');
  const timeoutLogged = logLines.some((l) => l.event === 'provider_dispatch_unconfirmed' && l.paymentId === firstBody.payment_id);
  assertEqual(timeoutLogged, true, 'provider_dispatch_unconfirmed was logged for this payment');
  log({ event: 'drill_assertion', step: 1, result: 'pass', detail: 'payment pending, no decline, one reconciliation message enqueued' });

  // Step 2: retry with the same idempotency key.
  log({ event: 'drill_step', step: 2, description: 'Re-POST the identical sale with the same idempotency key' });
  const retry = await fetch(`${base}/payments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'drill-1-key', ...authHeader(TENANT) },
    body: JSON.stringify(sale),
  });
  const retryBody = await retry.json();
  assertEqual(retry.status, 202, 'retry POST /payments status');
  assertEqual(retryBody.payment_id, firstBody.payment_id, 'retry returns the same payment, not a new one');
  assertEqual(dispatchCalls, 1, 'the retry did not trigger a second Daraja dispatch');
  log({ event: 'drill_assertion', step: 2, result: 'pass', detail: 'retry is idempotent — dispatchCalls still 1' });

  // Step 3: the automated reconciler alone cannot resolve this record —
  // there is no provider ID to query. Prove that explicitly rather than
  // assume it.
  log({ event: 'drill_step', step: 3, description: 'Automated reconciler attempts the enqueued message' });
  const resolvedAutomatically = await processMessage(enqueued[0], { paymentStore, payoutStore: null, darajaClient: client });
  assertEqual(resolvedAutomatically, false, 'processMessage correctly refuses to resolve a payment with no provider ID');
  const stillPending = paymentStore.findById(firstBody.payment_id);
  assertEqual(stillPending.status, 'pending', 'payment is still pending — no guessed outcome');
  log({ event: 'drill_assertion', step: 3, result: 'pass', detail: 'no providerRequestId => processMessage leaves it pending, per its own guard, headed for the DLQ per docs/runbook.md#reconciliation-dlq' });

  // Step 4: the human/DLQ step. An operator queries Daraja directly (out of
  // band — this is exactly what the runbook's DLQ procedure prescribes) and
  // confirms the charge actually succeeded. Resolve through the same
  // primitive the automated reconciler itself would use once it has an
  // answer — never inferred from the timeout itself.
  log({ event: 'drill_step', step: 4, description: 'Simulated DLQ step: operator confirms the true outcome with Daraja out-of-band and resolves the record' });
  const resolved = paymentStore.transition(firstBody.payment_id, 'succeeded');
  log({ event: 'manual_dlq_resolution', paymentId: firstBody.payment_id, status: resolved.status });

  // Step 5: confirm the final state end-to-end via the public API, and that
  // the entire drill only ever produced one Daraja dispatch attempt.
  const final = await fetch(`${base}/payments/${firstBody.payment_id}`, { headers: { ...authHeader(TENANT) } });
  const finalBody = await final.json();
  assertEqual(finalBody.status, 'succeeded', 'payment reached a terminal state');
  assertEqual(dispatchCalls, 1, 'exactly one Daraja dispatch attempt existed for the entire drill');
  log({ event: 'drill_assertion', step: 5, result: 'pass', detail: 'terminal state reached; exactly one dispatch attempt ever existed' });

  server.close();
  server.closeAllConnections?.();
  log({ event: 'drill_completed', drill: 'uncertain-payment', result: 'pass' });
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
