# k6 load profiles

Five profiles, run in this order. Each one answers a different question, and
running them out of order wastes time — a spike result means nothing if the
smoke test was already failing.

| Profile | Duration | Question it answers |
|---|---|---|
| `smoke.js` | 30s | Is the golden path wired correctly at all? |
| `baseline.js` | 10m | Do the SLOs hold at expected load? (stepped 5 → 60 RPS) |
| `spike.js` | ~4m40s | Does the system *recover* after a 15x surge? |
| `soak.js` | 16m | Does anything drift — memory, pool exhaustion, creeping latency? |
| `capacity.js` | 7m30s | Where is the knee? (ramps to 1500 RPS until the envelope breaks) |
| `step.js` | 90s each | Does the envelope hold at *this* rate? (`-e STEP_RATE=400`) |

`capacity.js` proves a ceiling exists and roughly where, but its summary is an
aggregate across every step — a run ending at 11% errors cannot say whether
250 RPS was fine and 1000 was not. `step.js` holds one rate at a time so each
candidate gets its own pass/fail verdict and its own exported JSON. Run
`capacity.js` first to bracket the knee, then `step.js` to pin it.

## Thresholds

From the brief: failed requests < 1%, p95 < 500 ms, checks > 99%. `baseline.js`
additionally holds the POS-specific SLO (p95 < 400 ms on sale creation) because
the blended figure would hide a slow write behind fast reads.

Every profile also carries `tillflow_duplicate_dispatch: ['count==0']`. Each
iteration pays a sale, then immediately pays it again with the same sale ID, and
asserts the second call is a no-op 200 rather than a second 202. Under
concurrency this is the failure that actually matters — a load test that only
measured latency would report a double-charging system as healthy.

`spike.js` and `capacity.js` deliberately relax the latency threshold (or record
rather than enforce it). Degrading under a surge is acceptable; taking money
twice is not, so the correctness threshold stays hard in both.

## Running

The profiles drive POS, which drives Payments. Both must be running with the
same `SERVICE_AUTH_SECRET`, and Payments must be in `fake` Daraja mode — the
brief's rule is that "CI and k6 must use a deterministic fake adapter, never
real money or customer data", and `DARAJA_MODE=fake` is what enforces it.

```bash
# terminal 1
cd services/payments && SERVICE_AUTH_SECRET=local-load-secret DARAJA_MODE=fake \
  PAYMENT_STORE=memory HOST=127.0.0.1 PORT=3001 node src/server.js

# terminal 2
cd services/pos && SERVICE_AUTH_SECRET=local-load-secret \
  PAYMENTS_BASE_URL=http://127.0.0.1:3001 POS_STORE=memory HOST=127.0.0.1 PORT=3002 \
  node src/server.js

# terminal 3 — from the repo root, so the JSON lands in evidence/
SERVICE_AUTH_SECRET=local-load-secret k6 run load/k6/smoke.js

# one sustained rate, for the capacity model
SERVICE_AUTH_SECRET=local-load-secret k6 run -e STEP_RATE=400 load/k6/step.js
```

Against a deployed environment, point it at the API Gateway instead. `smoke.js`
needs nothing extra — it has already been run this way (see
`evidence/reliability-operations/README.md`). `baseline.js` and `spike.js`
default to the same laptop-sized rates as the local runs above, which is not
appropriate to point at a `desired_count = 1` ECS task — override the rate
envs to start much lower and step up deliberately:

```bash
SERVICE_AUTH_SECRET=<the real secret> \
POS_BASE_URL=$(cd infra/main && terraform output -raw api_gateway_invoke_url) \
BASELINE_RATES=1,2,4,6,8 \
k6 run --summary-export evidence/reliability-operations/k6/deployed-baseline-$(date +%Y%m%d).json \
  load/k6/baseline.js | tee evidence/reliability-operations/k6/deployed-baseline-$(date +%Y%m%d).txt

SERVICE_AUTH_SECRET=<the real secret> \
POS_BASE_URL=$(cd infra/main && terraform output -raw api_gateway_invoke_url) \
SPIKE_BASE_RATE=1 SPIKE_PEAK_RATE=10 \
k6 run --summary-export evidence/reliability-operations/k6/deployed-spike-$(date +%Y%m%d).json \
  load/k6/spike.js | tee evidence/reliability-operations/k6/deployed-spike-$(date +%Y%m%d).txt

# soak already supports the same pattern
SERVICE_AUTH_SECRET=<the real secret> \
POS_BASE_URL=$(cd infra/main && terraform output -raw api_gateway_invoke_url) \
SOAK_RATE=2 SOAK_DURATION=16m \
k6 run --summary-export evidence/reliability-operations/k6/deployed-soak-$(date +%Y%m%d).json \
  load/k6/soak.js | tee evidence/reliability-operations/k6/deployed-soak-$(date +%Y%m%d).txt
```

Take a CloudWatch metrics snapshot (ECS CPU/memory, RDS CPU/connections, ALB
target response time) immediately before and after each run and save it
alongside the JSON, the same way the local capacity-model runs are documented
— the deployed ceiling is unmeasured, so these figures are what turns "it
worked once" into an actual envelope.

Each local run writes `evidence/reliability-operations/k6/<profile>.json` from
the repo root via `handleSummary`; the deployed runs above use `--summary-export`
to the same directory with a `deployed-` prefix instead, so the two are never
confused. That file is the evidence; the terminal summary is not.

## Reading the results

`docs/capacity-model.md` interprets the numbers — task size, scaling metric,
headroom, bottleneck, and the cost assumption behind them. The raw JSON on its
own does not make a capacity argument.
