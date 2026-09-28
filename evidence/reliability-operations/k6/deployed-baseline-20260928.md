# Deployed baseline: 28 Sep 2026, 17:50-18:00 EAT

`baseline.js` against the public API Gateway, stepping 1 -> 2 -> 4 -> 6 -> 8 iterations/s (2 min each),
one ECS task per service (`desired_count = 1`). Run from a laptop in Nairobi.

| Measure | Result | Threshold |
|---|---|---|
| Requests | 12,595 in 10 min, 0 failed | failed < 1% |
| p95, all requests | 275 ms | < 500 ms |
| p95, sale create | 268 ms | < 400 ms (POS SLO) |
| p95, sale pay | 301 ms | |
| Checks | 100% | > 99% |
| Duplicate dispatches | 0 | == 0 |
| Iterations | 2,099, 0 dropped, 0 interrupted | |

All thresholds passed at every step. At 8 iterations/s (about 6 requests each) the stack served roughly
48 requests/s (~2,900/min) across POS and Payments.

**Server side** (screenshots): POS p95 stayed around 20-30 ms at the ALB; zero 5xx; POS CPU peaked near 35%,
memory near 20%; RDS reached ~7 connections at low CPU. Money-correctness invariants stayed at zero during the
run. The single "daily close failure" at ~15:34 EAT is the unrelated `TENANT_IDS` incident documented in
`../alarms/`.

## Reading it honestly
- **No ceiling was found.** SLOs held up to at least 8 iterations/s; the stack did not break, and only 13 of
  50 virtual users were ever busy. The true ceiling for one task is higher and still unmeasured.
- **Client-side latency is mostly network.** The fastest requests take ~258 ms, which is the Nairobi to
  us-east-2 round trip; server-side p95 was ~25 ms. The client-measured SLO therefore understates server headroom.

Files: `deployed-baseline-20260928.json` (k6 summary export, the primary evidence), `.txt` (terminal output),
and three dashboard screenshots.
