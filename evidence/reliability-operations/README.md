# Reliability + operations — evidence

Normal DRI: @mercykilonzo. Cross-reviewed by @aine_mbabazi.

## What exists

### SLOs and error budgets
- `docs/slo-error-budgets.md` defines a 28-day SLI/SLO per service with an
  explicit numerator, denominator, exclusions, and the user outcome each SLI
  represents. Targets: Web 99.9%, POS 99.9%, Payments 99.5%, Commission 99.0%.
- Each budget is expressed as both a percentage and an absolute time
  (e.g. POS: 0.1% = 40m 19s per 28 days).
- Burn policy: fast burn (2% of budget in 1h) alerts; slow burn (5% in 6h)
  freezes releases. Definitions are written; the alerting implementation is a
  G3 item (see Known gaps).

### Threat model
- `docs/threat-model.md` is a STRIDE walk of the system with eight threats and
  a named mitigation for each. Covers Daraja callback forgery, cross-tenant
  reads, secret leakage, and replay.

### Incident log
- `docs/scar-log.md` records two real G1/G2 incidents with root cause and
  resolution: the S3 bucket-naming collision, and the OIDC trust-policy gap
  that blocked the POS release workflow.
- The OIDC entry documents the fix (scoping `job_workflow_ref` to exactly the
  workflows that need the deploy role) and the lesson.

### Telemetry
- POS and Payments run an ADOT collector sidecar; both task definitions set
  `OTEL_*` env vars and pass the collector config via `AOT_CONFIG_CONTENT`.
- Traces flow OTLP -> sidecar -> X-Ray; `docs/pos-spans.md` documents the POS
  span tree and the X-Ray id/propagator choice.
- Structured JSON logs carry `trace_id` and `span_id` in every entry.

## Live proof (run 2026-09-18)

A one-off ECS task hit POS's own /ready and /health from inside the VPC:

    {"service":"pos","event":"listening","posStore":"postgres"}
    {"service":"pos","status":"ready"}
    {"service":"pos","status":"ok"}

The /ready handler runs SELECT 1 against RDS - so a 200 on /ready is
positive proof that POS is reachable and its database dependency is healthy.

## Known gaps (deferred to G3)

- **No CloudWatch alarms wired.** SLO burn thresholds are written; the
  metric filters and alarms that enforce them are not provisioned.
- **No Slack alert contract implemented.** The template is specified (env,
  service, symptom, user/SLO impact, observed value, dashboard, runbook link,
  owner, first safe action) but no webhook fires yet.
- **No Grafana dashboards.** The panels required (5m/1h/28d uptime, SLO target,
  budget remaining, burn rate, RED, saturation, business signals) are listed
  in the brief; none are rendered.
- **No k6 load tests.** Smoke / stepped baseline / spike / 15-min soak are
  outstanding, along with the capacity model.
- **No synthetic probe.** The one-minute external probe described in the brief
  is not provisioned.
- **No game-day run recorded.** The five required recovery experiments
  (uncertain payment, callback replay, platform failure, broken release,
  restore) are planned but not yet exercised.
