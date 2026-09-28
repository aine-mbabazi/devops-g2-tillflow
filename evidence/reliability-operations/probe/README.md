# External synthetic probe: running evidence

Captured 28 Sep 2026 via AWS CLI (account 240462142849, us-east-2).

- `invocations-7d.txt`: Lambda `devops-g2-probe` invocations per day, last 7 days.
- `errors-7d.txt`: Lambda error count over the same window.
- `failed-run-2026-09-23.txt`: the single failed run in the window.
- `recent-log.txt`: sample runs. Each run checks `payments-health` and `payments-ready`
  through the public API Gateway edge and logs `probe_complete` with `successPercent`.

Scope: the probe checks the public edge and the Payments service. It does not exercise POS,
so the uptime panels measure edge + Payments reachability, not full-system availability.

## Result (7 days, 21-28 Sep 2026)
- 9,819 invocations, 1 failed run: 99.99% of probe runs passed.
- The one failure (`failed-run-2026-09-23.txt`): 23 Sep 03:14 UTC, `payments-ready` returned
  503 `not_ready`. Payments was up but reported a dependency not ready; the next run passed.
- A failing check throws, so failed runs appear in the Lambda `Errors` metric (`errors-7d.txt`).
- Log retention is 14 days, so this evidence is captured here rather than left in CloudWatch.
