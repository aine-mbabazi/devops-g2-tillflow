
## Result (7 days, 21-28 Sep 2026)
- 9,819 invocations, 1 failed run: 99.99% of probe runs passed.
- The one failure (`failed-run-2026-09-23.txt`): 23 Sep 03:14 UTC, `payments-ready` returned
  503 `not_ready`. Payments was up but reported a dependency not ready; the next run passed.
- A failing check throws, so failed runs appear in the Lambda `Errors` metric (`errors-7d.txt`).
- Log retention is 14 days, so this evidence is captured here rather than left in CloudWatch.
