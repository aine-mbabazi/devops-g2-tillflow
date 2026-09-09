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

## Budget policy (draft — finalized at G3)

- **Fast burn** (budget consumed rapidly, e.g. >2% of 28-day budget in 1 hour):
  page on-call immediately, freeze releases until root-caused.
- **Slow burn** (budget trending toward exhaustion over days): flag in daily
  standup, no freeze yet, prioritize the underlying fix.
- Feature work resumes once the burn rate returns to baseline and budget
  remaining is above the freeze threshold.

## Change control

Targets may change only before final benchmarking (G3), and only with a written
rationale recorded in this file's revision history.
