# Game day drill 3 — platform failure (re-run with a corrected injection)

DRI: @mercykilonzo (Reliability + operations), re-run by @aine-mbabazi
against the deployed stack while closing G4.

## What was broken, and how

**Two prior attempts (2026-09-20 ad hoc, and this script's first committed
version) stopped the Payments ECS task.** Neither ever captured the alarm
firing. Re-running the first version live on 2026-09-28 explained why
instead of leaving it a mystery: `ecs stop-task` triggers a graceful
deregistration — the target goes `draining`, then disappears — not an
ALB-detected health-check failure. The replacement task registered and
passed its own health check in ~28s, nowhere near the
`payments-unhealthy-targets` alarm's required 2 consecutive minutes of
`UnHealthyHostCount > 0`. **This injection is structurally incapable of
tripping that alarm**, independent of how many times it's retried — a
genuine defect in the drill's design, not a flaky run. See the earlier
failed attempt's transcript lines (top of
[`drill-03-transcript.jsonl`](drill-03-transcript.jsonl)) for the timed-out
run this replaced.

**Corrected injection:** the runbook's own drill 3 hypothesis
(`docs/runbook.md#game-day-drills`) names two candidates — "stop the
Commission worker, **or** revoke the RDS security group ingress" — not
"stop the Payments ECS task." Switched to the second: revoked the single
`devops-g2-rds-sg` ingress rule (TCP 5432 from `devops-g2-ecs-tasks-sg`)
that all three services share. Only POS's ALB target group polls a
dependency-aware endpoint (`/ready`) — Payments' polls `/health` (liveness
only, deliberately, per `docs/runbook.md#unhealthy-targets`) — so this
targets `pos-unhealthy-targets` specifically, exactly as the runbook
intends, using a real ALB-detected failure instead of a graceful stop.

## Timeline (UTC)

| Time | Event |
|---|---|
| 20:32:08 | RDS ingress revoked (all 3 services lose DB connectivity) |
| ~20:32–20:37 | POS's `/ready` starts failing once its DB pool's idle connections (10s default `idleTimeoutMillis`) are recycled against the revoked ingress; ALB marks the target `unhealthy` after 3 consecutive failed checks |
| 20:37:19 | `devops-g2-pos-unhealthy-targets` OK → ALARM, confirmed via real alarm history |
| 20:37:27 (poll) | Slack notifier delivered the firing alert, confirmed live |
| 20:37:47 | RDS ingress restored (first safe action — fix the dependency, not the ECS tasks) |
| 20:38:56 | POS target back to `healthy` — no task restart, same task, `/ready` simply started passing again |
| 20:41:19 | `devops-g2-pos-unhealthy-targets` ALARM → OK, confirmed via real alarm history |
| 20:41:35 | Slack notifier delivered the recovery alert, confirmed live |

Full transcript: [`drill-03-transcript.jsonl`](drill-03-transcript.jsonl)
(both the failed original-injection attempt and this corrected run, in
sequence). Machine evidence: [`g4-platform-failure.json`](../g4-platform-failure.json).

## Detected by

The real `devops-g2-pos-unhealthy-targets` CloudWatch alarm, off the real
`UnHealthyHostCount` metric on `devops-g2-pos-tg` — no `set-alarm-state` at
any point. Delivered to Slack by the real `devops-g2-slack-notifier`
Lambda, both directions.

## Recovery steps

Restore the RDS ingress rule — the dependency is the fault, not the ECS
tasks, so nothing about POS itself needed touching. Confirmed live: after
restoring the SG rule, the target group needed no task restart and no
manual intervention to return `healthy`.

## Measured RTO/RPO vs target

**RTO: 409 seconds (6m49s), against the 30-minute (1800s) target — comfortably
under.** Measured from ingress-revoked to POS-target-healthy-again
(20:32:08 → 20:38:56). No data loss — no data was ever written during the
outage window since POS's `/ready` failure kept the ALB from routing any
traffic to it.

## Pass/fail

**Pass.** All 7 checks in `g4-platform-failure.json` are true: RDS ingress
revoked, alarm fired from a real condition, Slack delivered the firing
alert, RDS ingress restored, POS target recovered without a task restart,
alarm recovered to `OK`, Slack delivered the recovery alert.

## Honest caveats

- **The injection changed mid-project, and the reason is a real, confirmed
  defect in the original drill design**, not a preference. The original
  script's own docstring claimed a specific recovery time (7m23s from the
  2026-09-20 ad hoc run) as if the alarm-firing half of the hypothesis was
  just uncaptured evidence; it was actually unreachable by that injection
  at all. That claim has been corrected in the script's own header comment.
- **The shared RDS security group means this injection briefly affects all
  three services, not just POS.** Payments stayed healthy throughout
  (liveness-only `/health`, unaffected by the DB outage) and Commission has
  no continuously-running service to affect — but any request that *did*
  touch the database during the ~5m40s window (20:32–20:37) would have
  failed. No real traffic was flowing at the time beyond the drill and the
  1-minute synthetic probe.
- The alarm's own evaluation window (2 consecutive 60s periods) means the
  409-second RTO is dominated by CloudWatch's own detection latency, not by
  POS's actual recovery time (which was near-instant once the pool
  reconnected) — worth separating "how fast did the system heal" from "how
  fast did we get told" when discussing this number.
