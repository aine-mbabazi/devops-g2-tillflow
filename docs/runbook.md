# TillFlow runbook

DRI: @mercykilonzo. Every alarm in `infra/main/alarms.tf` carries a `runbook`
anchor that links into this file — if you add an alarm, add its section here in
the same PR, or the Slack alert will link to nothing.

**The rule that overrides everything below:** TillFlow moves real money through
M-Pesa. A slow payment is not a failed payment. Never retry a payment or a
payout by hand to "unstick" it — reconciliation is the only sanctioned path to
resolving uncertain state, and a manual retry is how a customer gets charged
twice. If you are unsure, leave it pending and escalate.

---

## Contents

- [Recovery objectives](#recovery-objectives)
- [Rollback vs roll-forward](#rollback-vs-roll-forward)
- [Reconciliation order](#reconciliation-order)
- [Backup and restore](#backup-and-restore)
- Alarm responses:
  [POS 5xx](#pos-5xx) ·
  [Payments 5xx](#payments-5xx) ·
  [POS latency p95](#pos-latency-p95) ·
  [Web 5xx](#web-5xx) ·
  [Web latency p95](#web-latency-p95) ·
  [Budget fast burn](#budget-fast-burn) ·
  [Budget slow burn](#budget-slow-burn) ·
  [Payments callback lag](#payments-callback-lag) ·
  [Payments callback conflict](#payments-callback-conflict) ·
  [POS reconcile mismatch](#pos-reconcile-mismatch) ·
  [Commission close failed](#commission-close-failed) ·
  [RDS saturation](#rds-saturation) ·
  [RDS storage low](#rds-storage-low) ·
  [Unhealthy targets](#unhealthy-targets) ·
  [Synthetic probe failing](#synthetic-probe-failing) ·
  [Alert delivery failing](#alert-delivery-failing) ·
  [Cache degraded](#cache-degraded) ·
  [Reconciliation queue age](#reconciliation-queue-age) ·
  [Reconciliation DLQ](#reconciliation-dlq)
- [Game day drills](#game-day-drills)

---

## Recovery objectives

| Objective | Target | What it rests on |
|---|---|---|
| **RTO** — service restored | 30 minutes | ECS rollback to the previous task definition revision is a single API call and completes in ~3 minutes. The 30 minutes is detection plus decision, not mechanism. |
| **RPO** — data loss tolerated | 5 minutes | RDS automated backups with a 7-day retention window and point-in-time recovery. PITR replays the transaction log to any second in that window, so the real exposure is the ~5 minutes of replay lag, not the nightly snapshot. |
| **Commission deadline** | 06:30 EAT | The daily close runs at 05:00 EAT. That leaves ~90 minutes of slack for one failed run plus a manual re-run before the SLO is missed. |

Both numbers are currently **asserted, not yet measured**. The restore drill in
[Game day drills](#game-day-drills) is what converts them into evidence, and
until that drill has been run and timed, treat them as design intent.

The single-AZ RDS instance (ADR 0002) and single NAT gateway are the two places
where an AZ outage exceeds RTO regardless of anything in this document. That is
an accepted, documented trade — not an oversight.

---

## Rollback vs roll-forward

**Roll back when** the previous revision is known good and the fault is in the
new code or config. This is the default for anything caught by post-deploy
smoke.

```bash
# Find the previous ACTIVE revision
aws ecs list-task-definitions --family-prefix devops-g2-pos --status ACTIVE --sort DESC

# Point the service back at it
aws ecs update-service --cluster devops-g2 --service devops-g2-pos \
  --task-definition devops-g2-pos:<previous-revision> --force-new-deployment

# Watch it land
aws ecs wait services-stable --cluster devops-g2 --services devops-g2-pos
```

**Roll forward when** the fault is in data or in a dependency, not in the
deployed artifact. Rolling back a schema migration is almost always worse than
fixing forward — the migrations in `services/*/migrations/` are additive and
have no down-scripts, deliberately.

**Never roll back** to a revision built before a migration that has already
applied. The old image will not understand the new schema. Check the migration
log line (`migrations_complete`) in the service's log group before choosing a
target revision.

---

## Reconciliation order

When money state is uncertain, resolve it in this order. Doing it out of order
is how a double disbursement happens.

1. **Daraja is the source of truth.** Query the provider first
   (`queryPayment` / `queryB2C`). Never infer an outcome from a timeout.
2. **Payments reconciles itself against Daraja.** A pending payment whose
   provider query returns terminal gets transitioned. This is the only way a
   payment leaves `pending`.
3. **POS reconciles against Payments** — `POST /sales/:id/reconcile`. POS
   re-verifies tenant, sale ID, amount and currency before marking a sale paid;
   a mismatch is logged as `reconcile_mismatch` and the sale is deliberately
   *not* closed.
4. **Commission reconciles last** — `reconcilePendingLedgerEntries` runs before
   each close and updates ledger entries whose payouts have since resolved.

Commission must never call Daraja directly. This is enforced by a structural
test (`commission.test.js` — "commission never imports a Daraja client"), not
just by convention.

---

## Backup and restore

Automated RDS backups run 03:00–04:00 UTC (06:00–07:00 EAT), deliberately
*after* the daily close so a restore point always contains a complete
commission run rather than a half-finished one.

```bash
# Restore to a point in time, into a NEW instance — never over the live one
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier devops-g2-db \
  --target-db-instance-identifier devops-g2-db-restore \
  --restore-time 2026-09-18T02:30:00Z \
  --db-subnet-group-name devops-g2-db-subnets \
  --vpc-security-group-ids <devops-g2-rds-sg>
```

After any restore, before declaring recovery:

1. Verify row counts in `payments.payment_attempts` and `payments.payout_attempts`
   against the last known-good figures.
2. **Reconcile provider references.** A restore rewinds TillFlow's record of the
   world; it does not rewind Daraja's. Every payment that was `pending` at the
   restore point must be re-queried against Daraja — some of them completed
   during the window you just discarded, and replaying them as new payments
   would double-charge.
3. Only then repoint `DATABASE_URL` and restart the services.

Step 2 is the one that gets skipped under pressure. It is also the one that
costs real money when it is.

---

## POS 5xx

**Symptom:** POS is returning 5xx to attendants recording sales.
**Impact:** Attendants cannot record sales. Burns the POS 99.9% budget directly.

1. `aws ecs describe-services --cluster devops-g2 --services devops-g2-pos` —
   read the `events` array first. A task that cannot pull its image and a task
   that is crash-looping look identical from the load balancer.
2. Check `/devops-g2/pos` for `readiness_check_failed`. If present, this is a
   database problem wearing a POS costume — go to [RDS saturation](#rds-saturation).
3. Check `startup_error`. A config validation failure (missing
   `SERVICE_AUTH_SECRET` or `DATABASE_URL`) presents as a task that starts and
   immediately exits.
4. If the last deploy is recent, [roll back](#rollback-vs-roll-forward).

---

## Web 5xx

**Symptom:** The web API shell is returning 5xx to browsers.
**Impact:** The product is unusable from the front end even when POS and
Payments are healthy. Burns the Web 99.9% budget.

1. `aws ecs describe-services --cluster devops-g2 --services devops-g2-web` —
   events first, as always.
2. **Check POS before assuming Web is at fault.** The shell proxies to POS, so
   a POS outage surfaces here as well as on its own alarm. If
   `devops-g2-pos-5xx` is also firing, Web is the symptom and POS is the cause.
3. Check `/devops-g2/web` for `startup_error` — a config validation failure
   presents as a task that starts and immediately exits.
4. If the last deploy is recent, [roll back](#rollback-vs-roll-forward).

---

## Web latency p95

**Symptom:** Web p95 latency is above its 500 ms SLO target.
**Impact:** The product feels slow in the browser. The latency half of the Web
SLI is breached.

1. Compare against the POS latency panel first. The shell proxies to POS, so
   POS latency appears here amplified — one round trip of its own plus the one
   it is waiting on — rather than as a separate fault.
2. If POS p95 is healthy and Web's is not, the added time is in the shell
   itself; check ECS CPU and memory for `devops-g2-web`.
3. Do not scale Web to fix latency that originates in POS. It adds callers to
   the same bottleneck.

---

## Payments 5xx

**Symptom:** Payments is returning 5xx to POS and Commission.
**Impact:** Sales can be recorded but not paid. Burns the Payments 99.5% budget.

1. Check `/devops-g2/payments` for `provider_dispatch_unconfirmed` — this means
   payments *were* recorded but the Daraja dispatch is unconfirmed. Those are
   not lost; reconciliation resolves them.
2. **Do not retry payments by hand.** See the rule at the top of this file.
3. Check whether Daraja sandbox itself is failing before touching TillFlow. A
   dependency outage still counts against the budget (per
   `docs/slo-error-budgets.md`) but the fix is different.
4. If Payments is down but POS is up, sales will queue as unpaid. That is the
   designed degradation, not a second incident.

---

## POS latency p95

**Symptom:** POS p95 latency is above its 400 ms SLO target.
**Impact:** Recording a sale feels slow at the till. The latency half of the
POS SLI is breached.

1. Check ECS CPU and memory on the saturation panel. If both are flat, POS is
   not the bottleneck.
2. Check `DatabaseConnections` and RDS CPU. One `db.t4g.micro` is shared by all
   three services — it is the usual answer.
3. **Do not scale out before checking connections.** More POS tasks means more
   connections to the same small instance, which makes a connection-bound
   latency problem worse, not better.
4. If RDS is the bottleneck, the fix is the cache-aside layer on
   `GET /tenants/:id/config` (the read-heavy path), not more tasks.

---

## Budget fast burn

**Symptom:** POS is burning its 28-day error budget 14.4x faster than sustainable.
**Impact:** The whole 40m 19s budget is gone in under two days.

1. **Freeze releases.** Stop the release workflow before diagnosing — a deploy
   into an active burn is how a bad hour becomes a bad day.
2. A POS 5xx alert has almost certainly fired alongside this one. Triage that;
   this alarm is the budget consequence, not a separate fault.
3. Releases resume when the burn rate is back under 1x and budget remaining is
   above the freeze threshold in `docs/slo-error-budgets.md`.

---

## Budget slow burn

**Symptom:** POS is burning its budget 6x faster than sustainable.
**Impact:** Budget trending toward exhaustion over days.

**Do not page.** This is deliberately not a wake-up alert. Open a ticket, attach
the burn-rate panel, and raise it at the next standup. No release freeze.

If this fires repeatedly without a fast burn ever firing, the target itself may
be wrong — that is a conversation for the change-control process in
`docs/slo-error-budgets.md`, not a 3am decision.

---

## Payments callback lag

**Symptom:** Daraja callbacks are taking more than 60s to reach a terminal
state (p95).
**Impact:** Sales sit pending at the till after the customer has already paid.
This is what customers complain about first.

1. Run the reconciliation path. **Do not retry payments.**
2. Check whether the lag is Daraja's or ours: compare the `callback_processed`
   `callbackLagMs` values against the Daraja dashboard. If the callbacks are
   arriving late, the fix is not in TillFlow.
3. Check `callback_verification_unconfirmed` in `/devops-g2/payments` — that is
   TillFlow failing to *verify* a callback it received, which is our problem
   and usually means the Daraja query endpoint is timing out.

The metric behind this alarm comes from the `callback_processed` log event,
emitted once per payment on the transition that actually moves it to terminal.
Replays deliberately do not re-emit it — see `payments.test.js`, "a terminal
callback logs the lag the Payments SLI is measured from, once per payment".

---

## Payments callback conflict

**Symptom:** A Daraja callback reported an outcome that contradicts the stored
terminal state.
**Impact:** Possible money-state divergence between TillFlow and Daraja.

**Zero tolerance — any occurrence is investigated.**

1. **Do not mutate payment state.** Not through the API, not in the database.
2. Pull the `paymentId` from the `callback_conflict` log event. It carries both
   `storedStatus` and `verifiedStatus`.
3. Query Daraja directly for that transaction. Establish what actually happened
   to the customer's money before changing any record.
4. TillFlow deliberately keeps its stored terminal state and flags the conflict
   rather than overwriting — so nothing is lost by taking time here.

---

## POS reconcile mismatch

**Symptom:** Payments reported a succeeded payment whose tenant, sale, amount or
currency does not match POS's own sale record.
**Impact:** The sale was **not** marked paid, deliberately. A customer may have
been charged for a sale TillFlow will not close.

**Zero tolerance.**

1. Read the `reconcile_mismatch` log event — it carries both records side by side.
2. Establish which side is wrong before changing either. A mismatch is more
   likely a bug than a corruption, and the two have opposite fixes.
3. This is a customer-refund conversation, not just an engineering one. Escalate
   to the Payments DRI (@cheshari-pearl) immediately.

---

## Commission close failed

**Symptom:** The Commission daily close exited with an error.
**Impact:** Attendants do not get paid today. ~90 minutes of slack before the
06:30 EAT SLO deadline.

1. Read `/devops-g2/commission` for `daily_close_failed` and its `message`.
2. **Re-running is safe.** The `commissionRunId` is derived from the UTC date,
   so a re-run reuses the same idempotency keys and cannot double-pay. This is
   the one retry in this runbook that is sanctioned.

```bash
aws ecs run-task --cluster devops-g2 --launch-type FARGATE \
  --task-definition devops-g2-commission \
  --network-configuration 'awsvpcConfiguration={subnets=[<private-subnets>],securityGroups=[<ecs-tasks-sg>],assignPublicIp=DISABLED}'
```

3. If it fails again for the same reason, do not keep re-running. Escalate —
   missing one day's commission is recoverable, and a loop of failed closes
   burns the slack you need to fix it properly.

---

## RDS saturation

**Symptom:** RDS CPU above 80% for 15 minutes.
**Impact:** No direct user impact yet. This is the most likely next cause of a
latency breach across all three services.

1. Check Performance Insights for the dominant query.
2. **A resize is a restart** on a single-AZ instance — a brief full outage. Do
   not do it during trading hours unless the alternative is worse.
3. The cheaper fix for read pressure is cache-aside on the tenant-config path.

---

## RDS storage low

**Symptom:** Free storage below 4 GiB of the allocated 20 GiB.
**Impact:** Storage autoscaling is **disabled** (`max_allocated_storage = 0`).
At zero free, every write fails — POS, Payments and Commission stop at once.

1. Raise `allocated_storage` in `infra/main/rds.tf` and apply. Storage increases
   are online; they do not require a restart.
2. **Do not delete rows to buy space.** The payment and payout tables are the
   audit trail for real money movement.

---

## Unhealthy targets

**Symptom:** A target is failing its load balancer health check.
**Impact:** At `desired_count = 1` there is no healthy peer — one unhealthy
target means the service is **down**, not degraded.

1. ECS service events first, always.
2. Note the asymmetry between the two services, it matters for diagnosis:
   POS's target group polls `/ready` (dependency-aware, so a database outage
   drains it), Payments' polls `/health` (liveness only, so a database outage
   does *not* replace its tasks). That is deliberate and documented in
   `infra/main/payments-service.tf`.

---

## Synthetic probe failing

**Symptom:** The external probe cannot reach TillFlow through its public entry
point.
**Impact:** TillFlow is unreachable from the internet. Every SLI is breaching at
once. **This is the outage alert.**

1. **Check API Gateway before the services.** A VPC Link or integration failure
   looks exactly like every service being down simultaneously, and the services
   are usually fine.
2. Confirm from outside: `curl -s <api-gateway-invoke-url>/health`.
3. If the gateway answers but the probe fails, check the canary's own log group
   (`/aws/lambda/cwsyn-devops-g2-probe-*`) — a canary that has stopped running
   also fires this alarm, because `treat_missing_data = "breaching"`.

---

## Alert delivery failing

**Symptom:** The Slack notifier Lambda is throwing.
**Impact:** No direct user impact, but **every other alarm in this account is
now silent.** Treat as a page.

1. Check `/aws/lambda/devops-g2-slack-notifier` for `alert_delivery_failed`.
2. Confirm the secret holds a current webhook:
   `aws secretsmanager get-secret-value --secret-id devops-g2/slack-webhook`
   (the value is never in Terraform state or Git — that is by design).
3. Rotate it if the webhook was revoked:
   ```bash
   aws secretsmanager put-secret-value --secret-id devops-g2/slack-webhook \
     --secret-string 'https://hooks.slack.com/services/...'
   ```
   The notifier caches the URL per container, so a rotation takes effect on the
   next cold start.

**This alarm routes through the path it is reporting as broken.** If the
notifier is completely down, this alert cannot reach you either. That is why
the weekly manual check below exists rather than trusting this alarm alone:

```bash
aws sns publish --topic-arn <devops-g2-alerts> \
  --message '{"AlarmName":"manual-delivery-check","NewStateValue":"ALARM","NewStateReason":"Weekly verification [1.0 (manual)]","AlarmDescription":"{\"service\":\"reliability\",\"owner\":\"@mercykilonzo\",\"symptom\":\"Weekly alert-path verification. Not a real incident.\",\"impact\":\"None.\",\"first_action\":\"Acknowledge and ignore.\"}"}'
```

---

## Cache degraded

**Symptom:** The cache is evicting keys, or is unreachable.
**Impact:** No user-visible failure. Tenant config reads fall through to RDS, so
POS latency drifts toward its 400 ms SLO and RDS load rises.

POS is written to keep serving without the cache — every cache operation fails
open. So this is a latency and capacity problem, never an availability one.

1. Check the hit rate before resizing anything. A **low hit rate with high
   evictions** means the working set does not fit; a **high hit rate with high
   evictions** means the TTL is too long for the node size. Those have opposite
   fixes.
2. Check `/devops-g2/pos` for `cache_get_failed` and `cache_connect_failed`. If
   those are present, the node is unreachable rather than full — look at the
   security group and the `rediss://` scheme before the node size. Transit
   encryption is on, so a `redis://` URL fails to connect and POS degrades
   silently to Postgres forever.
3. `cache_invalidation_failed` with `staleUntilTtl: true` is the one entry that
   means users may be seeing **wrong** data rather than slow data: an owner
   reconfigured their till and the old config is still cached. It self-corrects
   within the TTL (60s by default).
4. Turning the cache off entirely is a safe rollback: set `POS_CACHE=off` and
   redeploy. POS runs exactly as it did before this ADR.

---

## Reconciliation queue age

**Symptom:** Reconciliation messages are sitting unprocessed for more than 10
minutes.
**Impact:** Payments whose Daraja dispatch was unconfirmed are not being
resolved. Sales stay pending at the till. Feeds directly into the callback-lag
SLI.

1. **Check whether the Payments tasks are running at all before touching the
   queue.** A stalled consumer and a slow Daraja look identical from this
   metric, and they have completely different fixes.
2. If the consumer is alive, check Daraja's own status. A provider outage puts
   every message into retry simultaneously.
3. Do **not** purge the queue to clear the alarm. Each message is a payment
   whose true state is unknown; discarding it discards the only prompt to go and
   find out.

---

## Reconciliation DLQ

**Symptom:** A payment could not be reconciled after five attempts and has
landed in the dead-letter queue.
**Impact:** At least one payment's true state is unknown to TillFlow. The
customer may have been charged for a sale that will never close.

**The alarm threshold is zero. One message is an incident.**

1. Read the message — it carries the payment ID.
2. Query Daraja directly for that payment. Establish what happened to the
   customer's money before changing any record.
3. **Do not redrive the queue until you know why it failed.** Five more attempts
   against a permanently failing case just refills the DLQ and hides the next
   genuine one behind it.
4. If the failure was transient and is now fixed, redrive:
   ```bash
   aws sqs start-message-move-task \
     --source-arn <devops-g2-reconciliation-dlq-arn> \
     --destination-arn <devops-g2-reconciliation-arn>
   ```

---

## Game day drills

The five recovery experiments the brief requires. Each one has a hypothesis, a
procedure, and a stated success criterion — an experiment without a falsifiable
prediction is just breaking things.

Record each run in `docs/scar-log.md` and link the evidence from
`evidence/reliability-operations/README.md`.

### 1. Uncertain payment

**Hypothesis:** A Daraja timeout leaves the payment pending, reconciliation
resolves it, and a retry cannot create a second charge.

Force a dispatch timeout, confirm `provider_dispatch_unconfirmed` is logged and
the payment stays `pending`. Re-POST the same sale with the same idempotency
key. **Success:** exactly one attempt exists, and reconciliation moves it to
terminal without a second Daraja dispatch.

### 2. Callback replay

**Hypothesis:** Replayed and reordered callbacks produce one legal transition
and one ledger effect.

Replay a terminal callback; then send a conflicting one. **Success:** the replay
is a no-op (no second `callback_processed`), the conflict is logged as
`callback_conflict` and the stored state is unchanged.

### 3. Platform failure

**Hypothesis:** Breaking a dependency degrades the system visibly, fires an
actionable Slack alert, and recovers without data loss.

Stop the Commission worker, or revoke the RDS security group ingress.
**Success:** the relevant alarm fires within its evaluation window, the Slack
message contains all nine contract fields, and an `OK` recovery message arrives
after the fix. Capture both messages.

### 4. Broken release

**Hypothesis:** A deliberately broken image is caught by post-deploy smoke and
rolled back inside RTO.

Deploy an image whose `/health` fails. **Success:** post-deploy smoke fails, the
rollback completes, and the total time from deploy to recovery is under 30
minutes — **timed, not asserted**.

### 5. Restore

**Hypothesis:** A point-in-time restore meets RPO, and provider references
reconcile cleanly afterwards.

Follow [Backup and restore](#backup-and-restore) into a new instance.
**Success:** RPO and RTO are measured and recorded, and step 2 of that section
(re-querying payments that were pending at the restore point) is executed and
its results captured. A restore that skips the reconciliation step does not
count as a pass.
