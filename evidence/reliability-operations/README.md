# Reliability + operations — evidence

DRI: @mercykilonzo. Cross-reviewed by @aine-mbabazi.

Covers SLIs/SLOs, budgets, ADOT/Grafana, k6, alerts, recovery experiments and
the runbook, per [`docs/ownership.md`](../../docs/ownership.md).

Assessment rule this file is written against: *evidence beats screenshots;
reproducibility beats explanation.* Every claim below names the file or command
that proves it, and the [Not yet proven](#not-yet-proven) section at the bottom
is deliberately specific rather than diplomatic.

---

## PRs

| PR | What it added |
|----|----------------|
| [#16](https://github.com/aine-mbabazi/devops-g2-tillflow/pull/16) | OIDC trust-policy fix that unblocked the POS release workflow (also in [`docs/scar-log.md`](../../docs/scar-log.md)) |
| (this branch) | CloudWatch alarms + the Slack alert contract and its notifier; the one-minute external synthetic probe; CloudWatch + Grafana SLO dashboards; the k6 load suite and capacity model; `docs/runbook.md`; the callback-lag metric the Payments SLI is measured from |

---

## SLOs and error budgets

[`docs/slo-error-budgets.md`](../../docs/slo-error-budgets.md) defines a 28-day
SLI/SLO per service with an explicit numerator, denominator, exclusions, and the
user outcome each SLI represents. Targets: Web 99.9%, POS 99.9%, Payments 99.5%,
Commission 99.0%. Each budget is expressed as both a percentage and an absolute
time (POS: 0.1% = 40m 19s per 28 days).

**The burn policy is now implemented, not just written.** Fast burn (14.4x, one
hour, 2.14% of budget) pages and freezes releases; slow burn (6x, six hours,
5.36%) deliberately does not page. Those exact numbers appear in four places
that can be checked against each other: the SLO document, the
`devops-g2-pos-budget-fast-burn` / `-slow-burn` alarms, the annotation lines on
both burn-rate panels, and the runbook's response sections.

The document previously stated these thresholds as approximations. They were
restated as exact multipliers so the four can actually be compared; the change
and its rationale are recorded in that file's revision history. **No SLO target
changed.**

---

## Alerting

**The path:** CloudWatch alarm → SNS → Lambda renderer → Slack.
[`infra/main/alerting.tf`](../../infra/main/alerting.tf),
[`infra/main/lambda/slack-notifier/index.mjs`](../../infra/main/lambda/slack-notifier/index.mjs).

**The contract** — the nine fields in
[`docs/alert-contract.md`](../../docs/alert-contract.md) — travels in each
alarm's own `alarm_description` as JSON rather than in a lookup table inside the
notifier. This is the design decision worth defending: a lookup table would let
someone add an alarm without adding its contract, and it would fire into Slack
with no owner and no first action. Here they are the same Terraform resource, in
the same PR, under the same CODEOWNER.

**Thirteen alarms**, split by what they are for:

| Kind | Alarms | Pages? |
|---|---|---|
| Availability | `pos-5xx`, `payments-5xx`, `pos-unhealthy-targets`, `payments-unhealthy-targets` | yes |
| Latency | `pos-latency-p95`, against POS's own 400 ms SLO rather than a shared number | yes |
| Budget burn | `pos-budget-fast-burn`, `pos-budget-slow-burn` | fast only |
| Money correctness | `payments-callback-lag`, `payments-callback-conflict`, `pos-reconcile-mismatch`, `commission-close-failed` | yes, at a threshold of zero |
| Saturation | `rds-cpu-high`, `rds-storage-low` | context only, deliberately loose |
| The alerting itself | `alert-delivery-failing` | yes |

The money-correctness alarms are what justify the area. A duplicated or
conflicting callback returns 200 to Daraja by design — no HTTP metric moves, no
latency changes, and nothing else in this list would notice. They are built from
log metric filters over the services' own structured logs, so they cost nothing
at the application layer and cannot drift from what the services actually log.

### Proof

```bash
node --test infra/main/lambda/slack-notifier/test.mjs   # 6/6
```

The renderer is a pure function of the alarm event, so the contract is asserted
rather than eyeballed in Slack once: that a firing alert carries all nine
fields, that a recovery alert is green and **drops** the first-safe-action block,
that an alarm with no contract still delivers and visibly shows `unassigned`
rather than a silent blank, and that a malformed event does not throw and take
the rest of the SNS batch down with it.

```bash
node scripts/check-alarm-runbook-anchors.mjs   # 13 alarms, 14 references, all resolving
```

Runs on every PR. It fails the build when an alarm links to a runbook section
nobody wrote, or carries no anchor at all. Writing it immediately found a real
gap: the per-service 5xx alarm assembled its anchor from `each.key`, so it could
not be verified before apply.

### The webhook

`devops-g2/slack-webhook` is declared in Terraform with **no**
`aws_secretsmanager_secret_version`. Writing the value through Terraform would
put it in both plan output and state, which the brief forbids. It is populated
once, out of band, and read at runtime by the notifier — not passed as a Lambda
environment variable, which would be readable via
`lambda:GetFunctionConfiguration` and rendered into state.

---

## Telemetry and dashboards

- POS and Payments run an ADOT collector sidecar; both task definitions set the
  `OTEL_*` variables and pass the collector config via `AOT_CONFIG_CONTENT`.
  Traces flow OTLP → sidecar → X-Ray.
  [`docs/pos-spans.md`](../../docs/pos-spans.md) documents the POS span tree and
  the X-Ray id/propagator choice.
- Structured JSON logs carry `trace_id` and `span_id` in every entry.
- **CloudWatch dashboard** `devops-g2-slo`, in Terraform
  ([`infra/main/dashboards.tf`](../../infra/main/dashboards.tf)): uptime at
  5m/1h/28d, budget remaining, burn rate with the alarm thresholds drawn on,
  RED per service, ECS and RDS saturation with the k6 envelope drawn on,
  business signals, and the integrity invariants.
- **Grafana dashboard**
  ([`observability/grafana/tillflow-slo-dashboard.json`](../../observability/grafana/tillflow-slo-dashboard.json)):
  the same panels over a CloudWatch datasource, so the two cannot disagree about
  the numbers — only about presentation.

The business panel is the one that earns its place. Sales recorded and payments
dispatched should track each other; a sustained gap means sales are being
recorded that never reach Payments — a product failure that every infrastructure
metric on the page reports as healthy.

---

## Synthetic probe

[`infra/main/synthetics.tf`](../../infra/main/synthetics.tf) — a one-minute
CloudWatch Synthetics canary, outside the VPC, over the public internet, through
API Gateway. Outside the VPC deliberately: a canary inside it would prove the
ALB answers its own subnet, which is not the claim being made.

It checks status **and** body, because API Gateway answers 200 with its own
error payload when a VPC Link integration is misconfigured — status alone would
report a broken gateway as healthy.

It is the only alarm in the stack with `treat_missing_data = "breaching"`. Every
other alarm treats missing data as fine, which is right for a system with idle
periods and useless for detecting total failure; a probe that has stopped
running is indistinguishable from a system that is down.

**Gated on `var.synthetic_probe_url`.** The public entry point arrives on a
separate branch ([#46](https://github.com/aine-mbabazi/devops-g2-tillflow/pull/46)),
so a hard reference would break `terraform plan` on `main` until that lands.
One line turns it on once the gateway is applied:

```bash
cd infra/main
terraform apply -var "synthetic_probe_url=$(terraform output -raw api_gateway_invoke_url)"
```

---

## Runbook

[`docs/runbook.md`](../../docs/runbook.md) — recovery objectives, rollback vs
roll-forward including the rule that you never roll back past an applied
migration, the reconciliation order, the restore procedure, a response section
per alarm, and the five game-day drills each with a falsifiable hypothesis.

The rule the whole document is built around: **a slow payment is not a failed
payment.** Most first-safe-actions are a form of "do not retry", because on this
system a manual retry is how a customer gets charged twice.

---

## Load testing and capacity

Profiles in [`load/k6/`](../../load/k6/README.md); analysis in
[`docs/capacity-model.md`](../../docs/capacity-model.md); raw exports in
[`k6/`](k6/).

### What was run

Nine runs, 2,087,857 requests, all executed locally against the deterministic
fake Daraja adapter per the brief's CI rule.

| Profile | Rate | Requests | Failed | p95 | checks | Duplicate dispatch | Verdict |
|---|---|---|---|---|---|---|---|
| smoke | 1 VU, 30s | 121 | 0% | 5.09 ms | 100% | **0** | pass |
| baseline | 5→60 stepped, 10m | 77,401 | 0% | 1.96 ms | 100% | **0** | pass |
| spike | 10→150→10 | 49,601 | 0% | 1.49 ms | 100% | **0** | pass |
| soak | 20 for 16m | 115,207 | 0% | 2.06 ms | 100% | **0** | pass |
| step | 200 | 108,001 | 0% | 0.68 ms | 100% | **0** | pass |
| step | 400 | 216,007 | 0% | 0.49 ms | 100% | **0** | pass — highest clean |
| step | 600 | 322,921 | 0% | 21.08 ms | 100% | **0** | SLOs hold, generator drops |
| step | 800 | 413,992 | 3.18% | 182.76 ms | 96.62% | **0** | fail |
| capacity | 100→1500 ramp | 784,606 | 11.15% | 1014.42 ms | 88.28% | **0** | fail by design |

**Highest sustained rate where every threshold holds: 400 iterations/s
(~2,400 HTTP req/s).**

The capacity ramp is *supposed* to fail — a profile that never breaks cannot
report a ceiling. The stepped baseline passed comfortably without ever
saturating anything, which meant it could not answer the brief's actual question
("the highest sustained RPS where SLOs hold"), so `capacity.js` was added to
bracket the knee and `step.js` to pin it.

### The result worth defending

**Zero duplicate dispatches in 2,087,857 requests** — including at 800 RPS where
3.18% of requests were failing, and at the capacity ramp's breaking point where
11% were.

Every k6 iteration pays a sale and immediately pays it again with the same sale
ID. POS answers `202` only on the call that genuinely dispatched an STK push;
once a payment is attached it answers `200` without touching Payments. A second
`202` is therefore a second STK push against one sale — a customer charged
twice. Saturation is exactly when that would appear, and it did not at any rate
tested. The system degrades by getting slower and refusing requests, not by
taking money twice.

`spike.js` and `capacity.js` relax the latency threshold deliberately —
degrading under a 15x surge is acceptable — but both keep
`tillflow_duplicate_dispatch: ['count==0']` hard.

### Soak: no drift

RSS sampled every 15s for the full 16 minutes
([`k6/soak-memory.csv`](k6/soak-memory.csv)): POS 33/102/203 MB
(min/mean/max), Payments 17/36/82 MB. Sawtooths with garbage collection,
**no upward trend.** Worth checking specifically because both services ran
in-memory stores that accumulate every sale and payment for the process
lifetime. Latency did not drift either — soak p95 2.06 ms against baseline
p95 1.96 ms ten minutes of runtime earlier.

### The caveat that governs all of it

These runs are **local**: k6, POS and Payments on one laptop, in-memory stores,
no ALB, no API Gateway, no RDS, no network between tiers. The latency figures
are loopback measurements and are **not** the deployed envelope.

What they establish is correctness under concurrency, the shape of the knee, and
stability over time. [`docs/capacity-model.md`](../../docs/capacity-model.md)
says this at length, gives the exact commands to measure the deployed envelope
once the API Gateway is applied, and explains why the cache before/after
comparison was deliberately **not** measured locally — POS serves tenant config
from an in-memory `Map` here, so a network round-trip in front of it would make
the "after" worse than the "before" and prove nothing.

### Cost finding

The capacity model prices the stack at roughly **$139/month** at list price. The
one-minute synthetic probe is ~$52 of that — the second-largest line item, more
than the database and more than both application services combined. The brief
specifies one minute so it stays, but the model documents the five-minute option
(~$10/month, ~15 min worst-case detection) as a deliberate decision rather than
an accident.

### Live infra: smoke run confirmed, 2026-09-21

`smoke.js` was run against the real deployed API Gateway/ALB
(`POS_BASE_URL` set to `terraform output api_gateway_invoke_url`), the first
k6 profile to leave loopback. All thresholds passed: 57 requests, 0% failed,
checks 100%, duplicate-dispatch protection held at zero.

Getting to a clean run surfaced two real gaps, both fixed rather than worked
around:

- **POS's ALB listener rule only matched `/sales*`.** Tenant config
  read/write had no route at all and fell through to the ALB's default
  404 action. Fixed in PR #71 by adding `/tenants*` to the same rule.
- **A stale, previously-fetched `SERVICE_AUTH_SECRET` in a local shell
  session caused every signed request to fail verification** with a
  generic `401 unauthenticated`, even though the signing algorithm on
  both sides (`load/k6/lib/auth.js` and `services/_shared/service-auth.js`)
  matched exactly. Re-fetching the secret immediately before the run
  resolved it — ECS injects secrets at container start, not live-reloaded,
  so this is the same class of staleness as a rotated secret not reaching
  a warm container until its next deploy.

---

## CI/CD and golden path

Second area owned by the same DRI ([`docs/ownership.md`](../../docs/ownership.md)).
It has no evidence directory of its own — the brief names four areas and
`ownership.md` splits CI/CD out as a fifth — so it is recorded here.

**Every PR runs:** three service test suites, the Slack notifier tests, the
runbook-anchor check, secret / dependency / IaC scanning (failing on fixable
HIGH/CRITICAL), a Docker build validation, `terraform plan`, and a k6 smoke
profile that includes the duplicate-dispatch threshold.

**Every release runs:** build → push by digest → **SBOM** (CycloneDX, generated
from the shipped image by digest, not from the source tree) → deploy →
**post-deploy smoke** → **automated rollback on failure**.

The smoke is three assertions, because `wait-for-service-stability` alone
proves only that ECS stopped churning:

1. The primary deployment reached `rolloutState = COMPLETED`.
2. Zero unhealthy targets in the service's target group.
3. **The running image digest equals the digest this run built.** A green
   rollout of the wrong image is the failure this catches, and it is what ties
   pipeline evidence to runtime.

Payments additionally curls `/health` through API Gateway — it owns `/health`
and `/ready` on the shared listener, so it is the one service reachable end to
end from outside. POS is exposed only at `/sales*`, which needs a signed
service-auth header the workflow deliberately does not hold.

On failure, the previous task definition (captured *before* the deploy) is
restored and the job still fails — a recovered deploy is not a successful one.

Commission has no smoke or rollback, deliberately: it is a one-shot scheduled
worker, so there is no rollout to watch and nothing running to roll back. Its
safety net is the `daily_close_failed` alarm plus a re-run being provably safe.
The workflow says so in place rather than being silently inconsistent.

**Now exercised:** drill 4 (below) ran a real release against a deliberately
broken image. The smoke check and automated rollback both engaged against a
real deploy; the recovery took longer than the 30-minute RTO target, and the
rollback confirmation step itself produced a false-negative timeout even
though the rollback succeeded. See "Game day — drill 4" and
`docs/scar-log.md` for the full timeline and the two findings that came out
of it.

---

## Not yet proven

Stated plainly, because the assessment rule rewards reproducibility over
explanation and these are the places where neither yet exists.

- **Drill 3 (platform failure) was executed.** The Payments task was
  stopped and ECS launched a replacement that returned healthy/running. The
  run lasted from 2026-09-20T21:48:30Z to 2026-09-20T21:55:53Z, for a measured
  recovery time of 7m 23s. The required platform-failure alarm firing and
  corresponding Slack alert were not captured, so this is execution evidence,
  not a full Drill 3 pass.
- **Drill 4 (broken release) was executed but exceeded RTO.** A deliberately
  broken `/health` was deployed via a real release (`release-pos.yml`); the
  post-deploy smoke check correctly failed to stabilize and automated
  rollback engaged. Total time from deploy start to a confirmed-good service
  was in the 30-36 minute range — at or past the 30-minute RTO target, not
  comfortably under it. See "Game day — drill 4" below and
  `docs/scar-log.md` for the full timeline; this is timed, executed evidence,
  but timed over budget, so it is not a passing Drill 4.
- **Drill 5 (restore) was executed but is not a full pass.** An RDS
  point-in-time restore completed in 35m 21s, exceeding the stated 30-minute
  RTO target. The required post-restore provider-reference reconciliation was
  not captured, so Drill 5 cannot be recorded as passing.
- **RTO and RPO are asserted, not measured.** The 30-minute and 5-minute figures
  are design intent derived from how the mechanisms work. Only the restore drill
  converts them into evidence.
- **The probe runs, but has not been confirmed publishing.** The
  Synthetics-canary deadlock described in earlier revisions of this file is
  resolved and no longer applies: the canary was removed and replaced with an
  EventBridge-scheduled Lambda (PR #81). `Infra Apply` went green at
  2026-09-21T14:51Z after a full day red, creating the schedule rule, target
  and invoke permission; the Lambda, its log group and the
  `devops-g2-synthetic-probe-failing` alarm were created in the partial apply
  minutes earlier. The old canary and its artifact bucket destroyed cleanly.

  What is **not** yet evidenced is a datapoint. Nobody has confirmed
  `TillFlow/synthetics` `SuccessPercent` actually has data:

  ```bash
  aws cloudwatch get-metric-statistics --namespace TillFlow/synthetics \
    --metric-name SuccessPercent --dimensions Name=ProbeName,Value=devops-g2-probe \
    --start-time "$(date -u -v-30M +%Y-%m-%dT%H:%M:%SZ)" \
    --end-time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --period 300 --statistics Average --region us-east-2
  ```

  There is one indirect signal in the meantime. The probe alarm is the only
  alarm in this stack with `treat_missing_data = "breaching"`, at 2-of-3
  datapoints on a 60-second period — so if the probe were not publishing, it
  would have gone to ALARM within about three minutes and delivered to Slack
  through the path this file already evidences. **Absence of that alert is
  weak evidence the probe is healthy; it is not a substitute for the metric.**

  Why the canary could not work, kept because the reasoning is the point: this
  account caps Lambda `MemorySize` at 512 MB, and the Terraform provider
  enforces a 960 MB floor for `aws_synthetics_canary`. No value satisfies both,
  so a canary is not creatable here at all. Full timeline in
  [`docs/scar-log.md`](../../docs/scar-log.md).
- **The Grafana dashboard has now been rendered against live CloudWatch,
  confirmed 2026-09-21.** A local Grafana instance (Docker) was pointed at a
  CloudWatch data source using the account's own credentials, and
  `tillflow-slo-dashboard.json` was imported without modification. The
  template variables resolved correctly against the real, live resources —
  `targetgroup/devops-g2-pos-tg/7e582f96ac9b869f`,
  `targetgroup/devops-g2-payments-tg/6b64453da157a4f8`, and
  `app/devops-g2-alb-iac/0457a5b4bad84da8` — proving the `arn_suffix`
  auto-discovery this dashboard was designed around actually works, not just
  that the JSON is syntactically valid.

  Every panel showed "No data" during that test, which was expected rather
  than a failure: at the time the uptime panels queried the canary that could
  never start, and the RED panels need sustained traffic in the query window —
  the only load run against the deployed stack is the 30-second k6 smoke run
  (see "Load testing and capacity"), too brief and too far outside the default
  6-hour window to register.

  **Two things about that test are now out of date.** The uptime panels no
  longer query `CloudWatchSynthetics`/`CanaryName`; PR #81 repointed them to
  `TillFlow/synthetics`/`ProbeName` when the canary was replaced by the Lambda
  probe, in both this dashboard and the CloudWatch one. And the probe is no
  longer stuck — it is deployed and scheduled. So the "No data" result above
  should not be read as the current state of the uptime panels; it is a record
  of a test run against the previous metric source.

  What that test does still prove, and it is the part worth keeping: the
  dashboard **imports cleanly against real infrastructure** and its template
  variables resolve against live resources. "Shows real data" remains
  unproven and needs the probe metric confirmed (see above) plus a sustained
  load window.
- **`smoke.js` has now run against the live deployed stack and passed** —
  see the new subsection under "Load testing and capacity" below. The other
  four profiles (`baseline`, `spike`, `soak`, `capacity`) remain local-only,
  by deliberate choice: running load-generating profiles against a
  `desired_count = 1` deployment this close to submission was judged too
  risky to the live demo environment. See the capacity model — they
  characterise correctness and shape, not the deployed envelope.

## Live alert delivery — confirmed 2026-09-20

A manual SNS publish to `devops-g2-alerts` was used to prove the full alert
path end to end, not just that it's declared in Terraform:

```bash
aws sns publish --topic-arn arn:aws:sns:us-east-2:240462142849:devops-g2-alerts \
  --message '{"AlarmName":"test-manual-trigger","NewStateValue":"ALARM","NewStateReason":"Manual test trigger"}' \
  --region us-east-2
```

CloudWatch Logs for `devops-g2-slack-notifier` confirm successful delivery:

{"event":"alert_delivered","alarm":"test-manual-trigger","state":"ALARM"}

The message landed in `devops-group-2` on Slack, correctly rendered through
the full alert contract from `docs/alert-contract.md` (environment, service,
owner, symptom, user/SLO impact, first safe action) — screenshot in this
evidence folder.

Two real issues were found and fixed to get here, both worth noting since they
reflect genuine operational behavior rather than a smoothed-over demo:

- The `devops-g2/slack-webhook` secret was left in a pending-deletion state
  from an earlier `terraform destroy` cycle and had to be restored and
  repopulated with a real webhook URL before any delivery could succeed.
- The Lambda intentionally caches the webhook URL per warm container (see the
  comment in `index.mjs`) to avoid a Secrets Manager call on every alarm —
  which means a secret rotation is not picked up until the next cold start.
  This was observed directly: updating the secret alone did not fix delivery
  until the function's execution environments were recycled.

**Recovery also confirmed**, same path, at 2026-09-20T19:12:01Z:
`{"event":"alert_delivered","alarm":"test-manual-trigger","state":"OK"}`.
Both the firing and recovery notifications from a single alarm's lifecycle
were delivered to Slack in this session.

## Game day — drills 1 & 2 confirmed, 2026-09-20

Executed against the real `app.js` / `payment-store.js` / `reconciliation-queue.js`
code, over real HTTP, on an ephemeral local server — DARAJA_MODE=fake per the
project's deterministic-adapter rule. Only the Daraja transport is a stub;
everything else is the actual production code path. Full JSON transcripts are
in `game-day/drill-01-transcript.jsonl` and `game-day/drill-02-transcript.jsonl`.

**Drill 1 — Uncertain payment** (`docs/runbook.md#game-day-drills`)

```bash
node evidence/reliability-operations/game-day/drill-01-uncertain-payment.mjs
```

Forces a Daraja dispatch timeout on the first attempt, confirms
`provider_dispatch_unconfirmed` is logged and the payment stays `pending`
(never declined), re-POSTs the identical sale with the same idempotency key
and confirms zero additional Daraja dispatches, then proves the automated
reconciler's own `processMessage` correctly *refuses* to resolve a payment
with no provider ID (`reconciliation-queue.js`'s guard) rather than guessing —
which is exactly why `docs/runbook.md#reconciliation-dlq` exists. The drill
completes the loop the way that DLQ procedure prescribes: an operator
confirms the true outcome with Daraja out-of-band, and the record is resolved
through the same `store.transition()` primitive the automated reconciler
itself uses once it has a confirmed answer. Result: exactly one Daraja
dispatch attempt for the whole drill, and a terminal state reached without
ever inferring an outcome from the timeout. All 5 assertions pass.

**Drill 2 — Callback replay** (`docs/runbook.md#game-day-drills`)

```bash
node evidence/reliability-operations/game-day/drill-02-callback-replay.mjs
```

Drives the original terminal callback (payment → `succeeded`, one
`callback_processed`), replays the identical callback (re-verifies as
`succeeded` again — a true no-op: still exactly one `callback_processed`,
stored state unchanged), then sends a reordered callback whose
re-verification disagrees with what's already recorded (`failed`). The
disagreement is logged as `callback_conflict` with both the stored and
verified status, the stored state is left untouched, and no second ledger
effect occurs. All 3 assertions pass — one legal transition, one ledger
effect, for the entire drill.

**Known scope limit, stated plainly:** both drills run against in-memory
stores on an ephemeral local server, not the deployed ECS/RDS stack — same
caveat as the k6 capacity runs above. They prove the invariants hold in the
real code; they do not prove the deployed infrastructure carries them
through. Drills 3–5 needed the live stack; all three have now been attempted
against it, and none is a full pass yet (see "Not yet proven" above for 3
and 5, and "Game day — drill 4" below).

## Game day — drill 4, 2026-09-20 (executed, exceeded RTO)

Unlike drills 1 & 2, this ran against the real deployed stack, not an
in-memory local server: PR #67 changed `services/pos/src/app.js` so
`GET`/`HEAD /health` always returns 500, and merged to `main`, which
triggers `release-pos.yml` on push.

```
23:22:18Z  PR #67 merged
23:22:59Z  Deploy to ECS started (wait-for-service-stability: true)
23:48:37Z  Wait timed out: {"state":"TIMEOUT","observedResponses":
           {"200: OK":9},"reason":"Waiter has timed out"} — the new
           revision never passed ECS's own container healthcheck
23:48:37Z  Roll back on failure fired: forced redeploy to the previous
           task definition (devops-g2-pos:13)
23:58:34Z  The rollback's own `aws ecs wait services-stable` ALSO timed
           out: "Waiter ServicesStable failed: Max attempts exceeded"
  after   Manual `describe-services` check confirmed the service was
           actually fine: status ACTIVE, running 1/1, one PRIMARY
           deployment on devops-g2-pos:13, rolloutState COMPLETED,
           failedTasks 0
```

**Result:** the failure was correctly detected and the rollback did
succeed, but total elapsed time (deploy start to confirmed-good) was in the
30–36 minute range — at or past the 30-minute RTO target, not comfortably
under it. Not a passing drill 4 by the runbook's own success criterion,
even though every mechanism involved (healthcheck, smoke-equivalent wait,
automated rollback) did the right thing.

**A second finding, independent of the RTO miss:** the workflow's own
`aws ecs wait services-stable` call is not a reliable success signal for
this stack — its default polling budget ran out before ECS finished
converging on both the failed forward deploy *and* the rollback, reporting
"failed" via `exit 1` in a case where the rollback had, in fact, succeeded.
Full timeline and remediation options (deployment circuit breaker, longer
or different stability check) are in `docs/scar-log.md`.

Revert of the intentional break: `services/pos/src/app.js` and
`services/pos/test/pos.test.js` in this PR.
