# SLOs and Error Budgets — TillFlow (Group 2)

_Draft targets for G0. Finalized with real measurement at G3._

## Reliability contract

| Service     | Primary SLI                                                                 | Starter target        | 28-day error budget      |
|-------------|-------------------------------------------------------------------------------|------------------------|----------------------------|
| Web         | Eligible page/API-shell loads succeed; p95 latency                            | ≥ 99.9%; p95 < 500ms  | 0.1% / 40m 19s             |
| POS API     | Valid sale writes accepted exactly once; p95 latency                          | ≥ 99.9%; p95 < 400ms  | 0.1% / 40m 19s             |
| Payments API| Valid STK/B2C commands accepted and callbacks processed within 60s            | ≥ 99.5%               | 0.5% / 3h 21m 36s          |
| Commission  | Eligible payouts reach terminal state by 06:30 EAT; duplicate disbursement = 0 | ≥ 99.0%               | 1% events / 0.28 late runs |

## Definitions

- **Numerator / denominator:** each SLI's numerator is the count of successful
  eligible events (per the service's definition above); the denominator is all
  eligible events in the measurement window.
- **Window:** 28 days, rolling.
- **Exclusions:** invalid requests and genuine business declines (e.g. a
  customer explicitly cancels) are excluded from the denominator. Dependency
  outages (e.g. Daraja sandbox unavailability) still count against the budget,
  since the user-facing journey still failed.
- **Budget:** `budget = eligible events x (1 - target)`.

## Budget policy (implemented)

Burn rate is the observed error ratio divided by the budget's allowed error
ratio. At 1x the budget lasts exactly the 28-day window; at 14.4x it is gone in
under two days.

| Class | Burn rate | Window | Share of budget consumed in that window | Response |
|---|---|---|---|---|
| **Fast burn** | > 14.4x | 1 hour | 2.14% | Page. Freeze releases until root-caused. |
| **Slow burn** | > 6x | 6 hours | 5.36% | Do **not** page. Ticket + next standup. No freeze. |

Feature work resumes once the burn rate returns below 1x and budget remaining is
above the freeze threshold.

These are not aspirations — they are the thresholds in
`infra/main/alarms.tf` (`devops-g2-pos-budget-fast-burn` and
`devops-g2-pos-budget-slow-burn`), the annotation lines on the burn-rate panel
of the CloudWatch and Grafana dashboards, and the response steps in
[`runbook.md`](runbook.md#budget-fast-burn). If any of those four disagree with
this table, this table wins and the other is the bug.

**Known simplification.** Google's multi-window burn-rate scheme pairs each long
window with a short one, so an alarm stops firing promptly once the burn stops.
This implementation uses a single window per class and relies on the alarm's OK
transition for recovery. That is weaker — a burn that ends mid-window keeps the
alarm latched until the window rolls — and it is a deliberate trade against
adding six more alarms on a two-week project.

## Change control

Targets may change only before final benchmarking (G3), and only with a written
rationale recorded here.

### Revision history

- **2026-09-18** — Burn thresholds restated from approximations ("about 2% of
  budget in 1 hour") to exact burn-rate multipliers (14.4x / 6x), so the
  document, the alarms and the dashboards can be checked against each other.
  No change to the intent or to any SLO target. The earlier draft also had a
  conflicting summary in circulation that described slow burn as freezing
  releases; it does not, and never did in this document.
