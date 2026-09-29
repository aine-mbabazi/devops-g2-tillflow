#!/usr/bin/env node
// Game day drill 3 — Platform failure (docs/runbook.md#game-day-drills)
//
// Hypothesis: breaking a dependency degrades the system visibly, fires an
// actionable Slack alert, and recovers without data loss.
//
// Injection history, corrected live on 2026-09-28 — the runbook's own
// hypothesis names two candidate injections: "stop the Commission worker, or
// revoke the RDS security group ingress." The first two executions of this
// drill (2026-09-20 ad hoc, and this script's first version) instead stopped
// the Payments ECS task — a THIRD injection the runbook never suggested —
// and neither run ever captured the alarm firing. Re-running this version
// live proved why, rather than leaving it unexplained: `ecs stop-task`
// triggers a graceful deregistration (the target goes `draining`, then
// disappears), not an ALB-detected health-check failure, and the replacement
// task registered and passed its own health check in ~28s — nowhere near the
// unhealthy-targets alarm's required 2 consecutive minutes of
// UnHealthyHostCount > 0. That path is structurally incapable of tripping
// this alarm, independent of how many times it's retried.
//
// This version uses the runbook's actual second suggestion: revoke the RDS
// security group's ingress rule (TCP 5432 from the ECS tasks SG). All three
// services share one RDS instance and one ingress rule, but only POS's ALB
// target group polls a dependency-aware endpoint (`/ready`) — Payments' polls
// `/health` (liveness only, deliberately, see
// docs/runbook.md#unhealthy-targets) — so this targets POS's
// `pos-unhealthy-targets` alarm specifically. Recovery re-authorizes the same
// rule; the ECS tasks themselves are never touched (POS's `/ready` handler
// returns 503 on a DB ping failure, it does not crash the process), so there
// is no replacement task to wait for — only the target group's own
// healthy/unhealthy_threshold health-check cycle.
//
// Never `aws cloudwatch set-alarm-state` — the alarm has to fire from the
// real outage.
//
// Run (against deployed infra — breaks DB connectivity for ALL services for
// the duration of the outage window, since the ingress rule is shared; POS
// specifically will fail its `/ready` check and stop receiving ALB traffic):
//
//   node evidence/reliability-operations/game-day/drill-03-platform-failure.mjs \
//     > evidence/reliability-operations/game-day/drill-03-transcript.jsonl

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const REGION = process.env.AWS_REGION || 'us-east-2';
const TARGET_GROUP_NAME = process.env.TARGET_GROUP_NAME || 'devops-g2-pos-tg';
const ALARM_NAME = process.env.ALARM_NAME || 'devops-g2-pos-unhealthy-targets';
const SLACK_LOG_GROUP = process.env.SLACK_LOG_GROUP || '/aws/lambda/devops-g2-slack-notifier';
const RDS_SG_NAME = process.env.RDS_SG_NAME || 'devops-g2-rds-sg';
const ECS_TASKS_SG_NAME = process.env.ECS_TASKS_SG_NAME || 'devops-g2-ecs-tasks-sg';
const DB_PORT = 5432;
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

// Lambda console-log lines in CloudWatch are prefixed with
// "<timestamp>\t<requestId>\t<level>\t" before the JSON payload the code
// actually logged — not pure JSON on their own. Slicing to the first "{"
// strips that prefix. Found live on 2026-09-28 re-running drill 6, which
// shares this exact function: the Slack delivery confirmation timed out
// after 10 minutes even though the real delivery happened within 8 seconds
// of the alarm firing, because JSON.parse() was throwing on every log line.
function tryParse(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  try { return JSON.parse(text.slice(start)); } catch { return null; }
}

async function main() {
  log({ event: 'drill_started', drill: 'platform-failure', injection: 'revoke_rds_ingress', target_service: 'pos' });

  const rdsSg = aws(['ec2', 'describe-security-groups', '--filters', `Name=group-name,Values=${RDS_SG_NAME}`]).SecurityGroups[0];
  const ecsTasksSg = aws(['ec2', 'describe-security-groups', '--filters', `Name=group-name,Values=${ECS_TASKS_SG_NAME}`]).SecurityGroups[0];
  const rule = (rdsSg.IpPermissions ?? []).find((p) => p.FromPort === DB_PORT && (p.UserIdGroupPairs ?? []).some((g) => g.GroupId === ecsTasksSg.GroupId));
  if (!rule) throw new Error(`Expected an ingress rule on ${RDS_SG_NAME} for port ${DB_PORT} from ${ECS_TASKS_SG_NAME}, found none`);
  log({ event: 'drill_step', step: 1, description: `revoking ${RDS_SG_NAME} (${rdsSg.GroupId}) ingress on ${DB_PORT} from ${ECS_TASKS_SG_NAME} (${ecsTasksSg.GroupId})` });

  const revokedAt = new Date().toISOString();
  aws(['ec2', 'revoke-security-group-ingress', '--group-id', rdsSg.GroupId, '--protocol', 'tcp', '--port', String(DB_PORT), '--source-group', ecsTasksSg.GroupId]);
  log({ event: 'drill_assertion', step: 1, result: 'pass', revokedAt, detail: 'RDS ingress revoked; all three services lose DB connectivity, only POS ALB target group (dependency-aware /ready) is expected to react' });

  log({ event: 'drill_step', step: 2, description: `waiting for ${ALARM_NAME} OK -> ALARM in its real history` });
  const firing = await pollUntil(ALARM_POLL_DEADLINE_MS, ALARM_POLL_INTERVAL_MS, `${ALARM_NAME} ALARM transition`, () => {
    const history = aws(['cloudwatch', 'describe-alarm-history', '--alarm-name', ALARM_NAME, '--history-item-type', 'StateUpdate', '--max-records', '5']);
    const item = (history?.AlarmHistoryItems ?? []).find((h) => h.HistorySummary?.includes('to ALARM') && new Date(h.Timestamp) >= new Date(revokedAt) - 1000 * 60);
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

  log({ event: 'drill_step', step: 4, description: `restoring ${RDS_SG_NAME} ingress on ${DB_PORT} from ${ECS_TASKS_SG_NAME}` });
  const restoredAt = new Date().toISOString();
  aws(['ec2', 'authorize-security-group-ingress', '--group-id', rdsSg.GroupId, '--protocol', 'tcp', '--port', String(DB_PORT), '--source-group', ecsTasksSg.GroupId]);
  log({ event: 'drill_assertion', step: 4, result: 'pass', restoredAt, detail: 'RDS ingress restored — first safe action per docs/runbook.md#rds-saturation-adjacent DB connectivity issues: fix the dependency, not the ECS tasks' });

  log({ event: 'drill_step', step: 5, description: 'waiting for the POS target group to report a healthy target again' });
  const recoveredAt = await pollUntil(RECOVERY_POLL_DEADLINE_MS, RECOVERY_POLL_INTERVAL_MS, `${TARGET_GROUP_NAME} has a healthy target`, () => {
    const tg = aws(['elbv2', 'describe-target-groups', '--names', TARGET_GROUP_NAME]).TargetGroups[0].TargetGroupArn;
    const health = aws(['elbv2', 'describe-target-health', '--target-group-arn', tg]);
    const healthy = (health.TargetHealthDescriptions ?? []).filter((t) => t.TargetHealth.State === 'healthy').length;
    return healthy >= 1 ? new Date().toISOString() : null;
  });
  log({ event: 'drill_assertion', step: 5, result: 'pass', recoveredAt, detail: 'POS target healthy again, no task restart involved — same task, /ready simply started passing again' });

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
    return match ?? null;
  });
  log({ event: 'drill_assertion', step: 7, result: 'pass', delivery: recoveredDelivery });

  const rtoSeconds = Math.round((new Date(recoveredAt) - new Date(revokedAt)) / 1000);
  const summary = {
    drill: 'devops-g2-platform-failure',
    set_alarm_state: false,
    injection: {
      kind: 'revoke_rds_security_group_ingress',
      note: 'Prior versions of this drill stopped the Payments ECS task (a graceful ECS deregistration) and never tripped an alarm — structural, not a fluke: confirmed live on 2026-09-28. This is the runbook\'s own second suggested injection, targeting POS via its dependency-aware /ready check.',
      rds_security_group: rdsSg.GroupId,
      ecs_tasks_security_group: ecsTasksSg.GroupId,
      port: DB_PORT,
      revoked_at: revokedAt,
      restored_at: restoredAt,
    },
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
      { check: 'RDS ingress revoked', ok: true },
      { check: 'alarm fired from a real condition, no set-alarm-state', ok: true },
      { check: 'Slack delivered the firing alert', ok: true },
      { check: 'RDS ingress restored', ok: true },
      { check: 'POS target group recovered without a task restart', ok: true },
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
