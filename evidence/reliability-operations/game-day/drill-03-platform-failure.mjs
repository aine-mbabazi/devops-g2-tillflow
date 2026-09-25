#!/usr/bin/env node
// Game day drill 3 — Platform failure (docs/runbook.md#game-day-drills)
//
// Hypothesis: breaking a dependency degrades the system visibly, fires an
// actionable Slack alert, and recovers without data loss.
//
// This drill was already executed once, against real deployed infra: the
// Payments task was stopped, ECS launched a replacement, and recovery was
// measured at 7m23s (2026-09-20T21:48:30Z -> 21:55:53Z). That run's only gap
// was not capturing the alarm firing and its Slack delivery — this script is
// the same injection, promoted from ad-hoc commands into a repeatable script,
// with that capture added: CloudWatch alarm-history transitions correlated
// against the Slack notifier Lambda's own log timestamps, the same technique
// used in drill 6. Never `aws cloudwatch set-alarm-state` — the alarm has to
// fire from the real outage.
//
// Run (against deployed infra — stops the live Payments task for the
// duration of the outage window; desired_count=1 means Payments is
// unavailable until the replacement task passes its health check, same as
// the first execution):
//
//   node evidence/reliability-operations/game-day/drill-03-platform-failure.mjs \
//     > evidence/reliability-operations/game-day/drill-03-transcript.jsonl

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const REGION = process.env.AWS_REGION || 'us-east-2';
const CLUSTER = process.env.CLUSTER || 'devops-g2';
const SERVICE = process.env.SERVICE || 'devops-g2-payments';
const TARGET_GROUP_NAME = process.env.TARGET_GROUP_NAME || 'devops-g2-payments-tg';
const ALARM_NAME = process.env.ALARM_NAME || 'devops-g2-payments-unhealthy-targets';
const SLACK_LOG_GROUP = process.env.SLACK_LOG_GROUP || '/aws/lambda/devops-g2-slack-notifier';
const RECOVERY_POLL_DEADLINE_MS = 15 * 60 * 1000;
const RECOVERY_POLL_INTERVAL_MS = 10_000;
const ALARM_POLL_DEADLINE_MS = 10 * 60 * 1000;
const ALARM_POLL_INTERVAL_MS = 15_000;

const logLines = [];
function log(entry) {
  const line = { ts: new Date().toISOString(), ...entry };
  logLines.push(line);
  console.log(JSON.stringify(line));
  return line;
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

function tryParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

async function main() {
  log({ event: 'drill_started', drill: 'platform-failure', cluster: CLUSTER, service: SERVICE });

  const before = aws(['ecs', 'describe-services', '--cluster', CLUSTER, '--services', SERVICE]);
  const desiredCount = before.services[0].desiredCount;
  const taskArns = aws(['ecs', 'list-tasks', '--cluster', CLUSTER, '--service-name', SERVICE]).taskArns;
  if (!taskArns?.length) throw new Error(`No running tasks found for ${SERVICE} — nothing to stop`);
  const targetTask = taskArns[0];
  log({ event: 'drill_step', step: 1, description: `stopping ${targetTask}`, desiredCount });

  const stoppedAt = new Date().toISOString();
  aws(['ecs', 'stop-task', '--cluster', CLUSTER, '--task', targetTask, '--reason', 'game-day drill 3 — platform failure']);
  log({ event: 'drill_assertion', step: 1, result: 'pass', stoppedAt, detail: 'stop-task issued; ECS should launch a replacement since desiredCount stays unchanged' });

  log({ event: 'drill_step', step: 2, description: `waiting for ${ALARM_NAME} OK -> ALARM in its real history` });
  const firing = await pollUntil(ALARM_POLL_DEADLINE_MS, ALARM_POLL_INTERVAL_MS, `${ALARM_NAME} ALARM transition`, () => {
    const history = aws(['cloudwatch', 'describe-alarm-history', '--alarm-name', ALARM_NAME, '--history-item-type', 'StateUpdate', '--max-records', '5']);
    const item = (history?.AlarmHistoryItems ?? []).find((h) => h.HistorySummary?.includes('to ALARM') && new Date(h.Timestamp) >= new Date(stoppedAt) - 1000 * 60);
    return item ?? null;
  });
  log({ event: 'drill_assertion', step: 2, result: 'pass', alarmTimestamp: firing.Timestamp, historySummary: firing.HistorySummary });

  log({ event: 'drill_step', step: 3, description: 'confirming Slack Lambda delivery for the firing alarm' });
  const firingDelivery = await pollUntil(ALARM_POLL_DEADLINE_MS, ALARM_POLL_INTERVAL_MS, 'Slack notifier ALARM delivery log line', () => {
    const events = aws(['logs', 'filter-log-events', '--log-group-name', SLACK_LOG_GROUP, '--start-time', String(new Date(firing.Timestamp).getTime() - 30_000), '--filter-pattern', '"alert_delivered"']);
    const match = (events?.events ?? []).map((e) => tryParse(e.message)).find((m) => m?.event === 'alert_delivered' && m?.alarm === ALARM_NAME && m?.state === 'ALARM');
    return match ?? null;
  });
  log({ event: 'drill_assertion', step: 3, result: 'pass', delivery: firingDelivery });

  log({ event: 'drill_step', step: 4, description: 'waiting for ECS to relaunch a healthy replacement task' });
  const recoveredAt = await pollUntil(RECOVERY_POLL_DEADLINE_MS, RECOVERY_POLL_INTERVAL_MS, `${SERVICE} back to runningCount == ${desiredCount}, target healthy`, () => {
    const svc = aws(['ecs', 'describe-services', '--cluster', CLUSTER, '--services', SERVICE]);
    const running = svc.services[0].runningCount;
    if (running !== desiredCount) return null;
    const tg = aws(['elbv2', 'describe-target-groups', '--names', TARGET_GROUP_NAME]).TargetGroups[0].TargetGroupArn;
    const health = aws(['elbv2', 'describe-target-health', '--target-group-arn', tg]);
    const healthy = (health.TargetHealthDescriptions ?? []).filter((t) => t.TargetHealth.State === 'healthy').length;
    return healthy >= 1 ? new Date().toISOString() : null;
  });
  log({ event: 'drill_assertion', step: 4, result: 'pass', recoveredAt, detail: 'replacement task running and target healthy' });

  log({ event: 'drill_step', step: 5, description: `waiting for ${ALARM_NAME} ALARM -> OK` });
  const recovered = await pollUntil(ALARM_POLL_DEADLINE_MS, ALARM_POLL_INTERVAL_MS, `${ALARM_NAME} OK transition`, () => {
    const history = aws(['cloudwatch', 'describe-alarm-history', '--alarm-name', ALARM_NAME, '--history-item-type', 'StateUpdate', '--max-records', '5']);
    const item = (history?.AlarmHistoryItems ?? []).find((h) => h.HistorySummary?.includes('to OK') && new Date(h.Timestamp) > new Date(firing.Timestamp));
    return item ?? null;
  });
  log({ event: 'drill_assertion', step: 5, result: 'pass', alarmTimestamp: recovered.Timestamp, historySummary: recovered.HistorySummary });

  const recoveredDelivery = await pollUntil(ALARM_POLL_DEADLINE_MS, ALARM_POLL_INTERVAL_MS, 'Slack notifier OK delivery log line', () => {
    const events = aws(['logs', 'filter-log-events', '--log-group-name', SLACK_LOG_GROUP, '--start-time', String(new Date(recovered.Timestamp).getTime() - 30_000), '--filter-pattern', '"alert_delivered"']);
    const match = (events?.events ?? []).map((e) => tryParse(e.message)).find((m) => m?.event === 'alert_delivered' && m?.alarm === ALARM_NAME && m?.state === 'OK');
    return match ?? null;
  });
  log({ event: 'drill_assertion', step: 6, result: 'pass', delivery: recoveredDelivery });

  const rtoSeconds = Math.round((new Date(recoveredAt) - new Date(stoppedAt)) / 1000);
  const summary = {
    drill: 'devops-g2-platform-failure',
    set_alarm_state: false,
    injection: { kind: 'ecs_stop_task', task: targetTask, cluster: CLUSTER, service: SERVICE, stopped_at: stoppedAt },
    alarm: {
      name: ALARM_NAME,
      ok_to_alarm: firing.Timestamp,
      alarm_to_ok: recovered.Timestamp,
      alarm_reason: firing.HistorySummary,
      ok_reason: recovered.HistorySummary,
    },
    slack_lambda: { log_group: SLACK_LOG_GROUP, firing: firingDelivery, recovered: recoveredDelivery },
    rto: { seconds: rtoSeconds, target_seconds: 1800, met: rtoSeconds <= 1800 },
    checks: [
      { check: 'target task stopped', ok: true },
      { check: 'alarm fired from a real condition, no set-alarm-state', ok: true },
      { check: 'Slack delivered the firing alert', ok: true },
      { check: 'ECS relaunched a healthy replacement without manual intervention', ok: true },
      { check: 'alarm recovered to OK', ok: true },
      { check: 'Slack delivered the recovery alert', ok: true },
    ],
  };
  writeFileSync('evidence/reliability-operations/g4-platform-failure.json', JSON.stringify(summary, null, 2));
  log({ event: 'drill_completed', drill: 'platform-failure', result: 'pass', rtoSeconds });
}

main().catch((error) => {
  console.error('DRILL FAILED WITH EXCEPTION', error);
  process.exit(1);
});
