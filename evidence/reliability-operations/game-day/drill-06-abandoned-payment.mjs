#!/usr/bin/env node
// Game day drill 6 — Real alarm firing -> recovery, against DEPLOYED infra
// (docs/runbook.md#game-day-drills, "Platform failure" hypothesis's Slack half,
// and the G3 requirement that an alarm actually fire from a real condition).
//
// Rule this drill is written against: never `aws cloudwatch set-alarm-state`.
// The condition has to be real, so the CloudWatch alarm-history timestamps
// and the Slack notifier Lambda's own log timestamps can be cross-checked
// against each other rather than asserted.
//
// Mechanism, confirmed by reading the live code paths before writing this:
//   - The deployed Payments task runs DARAJA_MODE=fake (infra/main/payments-task.tf),
//     so POST /payments against the real API Gateway dispatches through the
//     same FakeDarajaClient as local dev and gets back a real providerRequestId
//     with status "pending".
//   - reconciliation-queue.js#processMessage calls darajaClient.queryPayment,
//     which returns "pending" forever unless FakeDarajaClient#simulateOutcome
//     was called — and that method is JS-only, never reachable over HTTP. So a
//     payment created this way can NEVER be resolved through the public
//     callback endpoint. That is not a bug being exploited; it is what makes
//     "leave it alone" a completely deterministic way to reach the DLQ.
//   - After 5 redeliveries over the 60s visibility timeout, the message lands
//     in devops-g2-reconciliation-dlq, tripping devops-g2-reconciliation-dlq-not-empty
//     (threshold 0) for real.
//   - Recovery: per docs/runbook.md#reconciliation-dlq, an operator reads the
//     message and establishes what happened before touching anything. Here
//     that is known immediately and provably: this is our own drill payment,
//     and it is a permanently unresolvable case, not a transient one (no HTTP
//     path exists to ever resolve it). The runbook explicitly says not to
//     redrive a permanently-failing case ("just refills the DLQ"), so the
//     correct first safe action is to delete the message from the DLQ once
//     its identity is confirmed — not to redrive it blindly.
//
// Run (against deployed infra — costs nothing but ~10-15 minutes of wall
// clock, and creates exactly one synthetic, DARAJA_MODE=fake payment):
//
//   export API_URL=$(cd infra/main && terraform output -raw api_gateway_invoke_url)
//   export SERVICE_AUTH_SECRET=<real value, from Secrets Manager>
//   export TENANT_ID=<a tenant configured in the deployed stack>
//   export DLQ_URL=$(cd infra/main && terraform output -raw reconciliation_dlq_url)
//   node evidence/reliability-operations/game-day/drill-06-abandoned-payment.mjs \
//     > evidence/reliability-operations/game-day/drill-06-transcript.jsonl

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { signServiceAuth } from '../../../services/_shared/service-auth.js';

const API_URL = requireEnv('API_URL');
const SERVICE_AUTH_SECRET = requireEnv('SERVICE_AUTH_SECRET');
const TENANT_ID = requireEnv('TENANT_ID');
const DLQ_URL = requireEnv('DLQ_URL');
const REGION = process.env.AWS_REGION || 'us-east-2';
const ALARM_NAME = process.env.ALARM_NAME || 'devops-g2-reconciliation-dlq-not-empty';
const SLACK_LOG_GROUP = process.env.SLACK_LOG_GROUP || '/aws/lambda/devops-g2-slack-notifier';
const DLQ_POLL_DEADLINE_MS = 15 * 60 * 1000; // alarm eval period (300s) + delivery retries can push this close to 10-12 min
const DLQ_POLL_INTERVAL_MS = 15_000;
const ALARM_POLL_DEADLINE_MS = 10 * 60 * 1000;
const ALARM_POLL_INTERVAL_MS = 15_000;

const logLines = [];
function log(entry) {
  const line = { ts: new Date().toISOString(), ...entry };
  logLines.push(line);
  console.log(JSON.stringify(line));
  return line;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

function aws(args) {
  const out = execFileSync('aws', [...args, '--region', REGION, '--output', 'json'], { encoding: 'utf8' });
  return out.trim() ? JSON.parse(out) : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil(deadlineMs, intervalMs, description, check) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    const result = await check();
    if (result) return result;
    log({ event: 'poll_waiting', description, elapsedMs: Date.now() - start });
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for: ${description}`);
}

function authHeader() {
  return signServiceAuth(TENANT_ID, SERVICE_AUTH_SECRET);
}

async function main() {
  log({ event: 'drill_started', drill: 'abandoned-payment', api: API_URL, tenant: TENANT_ID });

  // Step 1: create a payment and deliberately never send its callback.
  const saleId = `drill-06-${Date.now()}`;
  const body = {
    tenant_id: TENANT_ID, sale_id: saleId, amount_minor: 15000, currency: 'KES',
    customer_phone: '+254700000099',
  };
  log({ event: 'drill_step', step: 1, description: 'POST /payments — dispatch a payment we will never confirm' });
  const created = await fetch(`${API_URL}/payments`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': saleId,
      'x-service-auth': authHeader(),
    },
    body: JSON.stringify(body),
  });
  const createdBody = await created.json();
  if (created.status !== 202 || createdBody.status !== 'pending') {
    throw new Error(`Expected 202 pending, got ${created.status} ${JSON.stringify(createdBody)}`);
  }
  const paymentId = createdBody.payment_id;
  log({ event: 'drill_assertion', step: 1, result: 'pass', paymentId, detail: 'payment dispatched, pending, callback withheld on purpose' });

  // Step 2: wait for the message to age out of the main queue and land in the DLQ.
  log({ event: 'drill_step', step: 2, description: `waiting for the reconciliation message for ${paymentId} to land in the DLQ (up to 5 redeliveries over the 60s visibility timeout)` });
  const dlqLandedAt = await pollUntil(DLQ_POLL_DEADLINE_MS, DLQ_POLL_INTERVAL_MS, `message for ${paymentId} visible in the DLQ`, () => {
    const attrs = aws(['sqs', 'get-queue-attributes', '--queue-url', DLQ_URL, '--attribute-names', 'ApproximateNumberOfMessagesVisible']);
    const count = Number(attrs?.Attributes?.ApproximateNumberOfMessagesVisible ?? 0);
    if (count >= 1) return new Date().toISOString();
    return null;
  });
  log({ event: 'drill_assertion', step: 2, result: 'pass', dlqLandedAt, detail: 'DLQ has at least one visible message' });

  // Step 3: the real CloudWatch alarm fires — confirmed via alarm history, not asserted.
  log({ event: 'drill_step', step: 3, description: `waiting for ${ALARM_NAME} OK -> ALARM in its real history` });
  const firing = await pollUntil(ALARM_POLL_DEADLINE_MS, ALARM_POLL_INTERVAL_MS, `${ALARM_NAME} ALARM transition`, () => {
    const history = aws(['cloudwatch', 'describe-alarm-history', '--alarm-name', ALARM_NAME, '--history-item-type', 'StateUpdate', '--max-records', '5']);
    const item = (history?.AlarmHistoryItems ?? []).find((h) => h.HistorySummary?.includes('to ALARM') && new Date(h.Timestamp) >= new Date(dlqLandedAt) - 1000 * 300);
    return item ?? null;
  });
  log({ event: 'drill_assertion', step: 3, result: 'pass', alarmTimestamp: firing.Timestamp, historySummary: firing.HistorySummary });

  // Step 4: confirm the Slack notifier actually delivered it, not a placeholder.
  log({ event: 'drill_step', step: 4, description: 'confirming Slack Lambda delivery for the firing alarm' });
  const firingDelivery = await pollUntil(ALARM_POLL_DEADLINE_MS, ALARM_POLL_INTERVAL_MS, 'Slack notifier ALARM delivery log line', () => {
    const events = aws(['logs', 'filter-log-events', '--log-group-name', SLACK_LOG_GROUP, '--start-time', String(new Date(firing.Timestamp).getTime() - 30_000), '--filter-pattern', '"alert_delivered"']);
    const match = (events?.events ?? []).map((e) => tryParse(e.message)).find((m) => m?.event === 'alert_delivered' && m?.alarm === ALARM_NAME && m?.state === 'ALARM');
    return match ? { message: match, requestId: match.requestId } : null;
  });
  log({ event: 'drill_assertion', step: 4, result: 'pass', delivery: firingDelivery.message });

  // Step 5 (recovery): read the DLQ message, confirm it is our own known-permanent
  // drill payment, and delete it rather than redrive it (runbook.md#reconciliation-dlq).
  log({ event: 'drill_step', step: 5, description: 'reading and resolving the DLQ message (first safe action, not a redrive)' });
  const received = aws(['sqs', 'receive-message', '--queue-url', DLQ_URL, '--max-number-of-messages', '1', '--wait-time-seconds', '5']);
  const message = received?.Messages?.[0];
  if (!message) throw new Error('Expected a visible DLQ message to receive, found none');
  const messageBody = tryParse(message.Body);
  if (messageBody?.type !== 'payment' || messageBody?.id !== paymentId) {
    throw new Error(`DLQ message does not match our drill payment (got ${JSON.stringify(messageBody)}) — refusing to delete an unrelated message`);
  }
  aws(['sqs', 'delete-message', '--queue-url', DLQ_URL, '--receipt-handle', message.ReceiptHandle]);
  log({ event: 'drill_assertion', step: 5, result: 'pass', detail: 'confirmed message belongs to this drill\'s own payment, deleted per runbook (not redriven — permanently unresolvable in fake mode)' });

  // Step 6: the alarm recovers for real.
  log({ event: 'drill_step', step: 6, description: `waiting for ${ALARM_NAME} ALARM -> OK` });
  const recovered = await pollUntil(ALARM_POLL_DEADLINE_MS, ALARM_POLL_INTERVAL_MS, `${ALARM_NAME} OK transition`, () => {
    const history = aws(['cloudwatch', 'describe-alarm-history', '--alarm-name', ALARM_NAME, '--history-item-type', 'StateUpdate', '--max-records', '5']);
    const item = (history?.AlarmHistoryItems ?? []).find((h) => h.HistorySummary?.includes('to OK') && new Date(h.Timestamp) > new Date(firing.Timestamp));
    return item ?? null;
  });
  log({ event: 'drill_assertion', step: 6, result: 'pass', alarmTimestamp: recovered.Timestamp, historySummary: recovered.HistorySummary });

  const recoveredDelivery = await pollUntil(ALARM_POLL_DEADLINE_MS, ALARM_POLL_INTERVAL_MS, 'Slack notifier OK delivery log line', () => {
    const events = aws(['logs', 'filter-log-events', '--log-group-name', SLACK_LOG_GROUP, '--start-time', String(new Date(recovered.Timestamp).getTime() - 30_000), '--filter-pattern', '"alert_delivered"']);
    const match = (events?.events ?? []).map((e) => tryParse(e.message)).find((m) => m?.event === 'alert_delivered' && m?.alarm === ALARM_NAME && m?.state === 'OK');
    return match ? { message: match, requestId: match.requestId } : null;
  });
  log({ event: 'drill_assertion', step: 7, result: 'pass', delivery: recoveredDelivery.message });

  const summary = {
    drill: 'devops-g2-abandoned-payment',
    set_alarm_state: false,
    payment_id: paymentId,
    sale_id: saleId,
    tenant_id: TENANT_ID,
    alarm: {
      name: ALARM_NAME,
      ok_to_alarm: firing.Timestamp,
      alarm_to_ok: recovered.Timestamp,
      alarm_reason: firing.HistorySummary,
      ok_reason: recovered.HistorySummary,
    },
    slack_lambda: {
      log_group: SLACK_LOG_GROUP,
      firing: firingDelivery.message,
      recovered: recoveredDelivery.message,
    },
    dlq: {
      queue_url: DLQ_URL,
      landed_at: dlqLandedAt,
      resolution: 'deleted, not redriven — permanently unresolvable in DARAJA_MODE=fake',
    },
    checks: [
      { check: 'payment dispatched as pending', ok: true },
      { check: 'message reached the DLQ', ok: true },
      { check: 'alarm fired from a real condition, no set-alarm-state', ok: true },
      { check: 'Slack delivered the firing alert, not a placeholder', ok: true },
      { check: 'DLQ message matched this drill\'s own payment before deletion', ok: true },
      { check: 'alarm recovered to OK', ok: true },
      { check: 'Slack delivered the recovery alert', ok: true },
    ],
  };
  writeFileSync('evidence/reliability-operations/g3-alarm-firing.json', JSON.stringify(summary, null, 2));
  log({ event: 'drill_completed', drill: 'abandoned-payment', result: 'pass' });
}

function tryParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

main().catch((error) => {
  console.error('DRILL FAILED WITH EXCEPTION', error);
  process.exit(1);
});
