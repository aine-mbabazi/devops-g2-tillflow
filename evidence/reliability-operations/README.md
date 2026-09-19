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

**Not proven:** no release workflow has run since these changes, so the smoke
and the rollback are untested against a real deploy. Proving the rollback is
the G4 "broken release" drill, which has not been run.

---

## Not yet proven

Stated plainly, because the assessment rule rewards reproducibility over
explanation and these are the places where neither yet exists.

- **No game day has been run.** All five drills are specified in the runbook
  with hypotheses and success criteria; none has been executed. This is the
  largest remaining gap in this area, and the one that blocks G4.
- **RTO and RPO are asserted, not measured.** The 30-minute and 5-minute figures
  are design intent derived from how the mechanisms work. Only the restore drill
  converts them into evidence.
- **No Slack message has actually been delivered.** The renderer is unit tested
  and the path is provisioned in code, but nothing from this branch has been
  applied to AWS, so no alert has round-tripped to a real channel. Capturing one
  firing and one recovery message is a five-minute task once `terraform apply`
  runs and the webhook secret is populated.
- **The probe has never run.** It stays unprovisioned until
  `synthetic_probe_url` is set, which needs the API Gateway branch merged and
  applied first.
- **The Grafana dashboard has not been rendered.** No Grafana instance exists.
  The JSON is committed and its queries mirror the CloudWatch dashboard's, but
  "imports cleanly" is an untested claim. Its ALB dimensions resolve through
  template variables at import rather than hardcoded values, precisely because
  the `arn_suffix` is not knowable at commit time.
- **The k6 runs are local.** See the capacity model — they characterise
  correctness and shape, not the deployed envelope.
