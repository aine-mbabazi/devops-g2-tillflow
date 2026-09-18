# Capacity model

DRI: @mercykilonzo. Raw exports: [`evidence/reliability-operations/k6/`](../evidence/reliability-operations/k6/).
Profiles and how to run them: [`load/k6/README.md`](../load/k6/README.md).

---

## Read this first — what these numbers are and are not

Every run below was executed **locally**: k6, POS and Payments all on one
laptop, with in-memory stores and the deterministic fake Daraja adapter. There
is no ALB, no API Gateway, no RDS, no network between the tiers, and no ECS task
sizing involved.

So the latency figures are **not** the deployed envelope and must never be
quoted as one. A p95 of 0.49 ms is a loopback measurement; the deployed path
adds an internet hop, API Gateway, a VPC Link, an ALB, and a real database
round-trip on every write.

What the runs do establish, and what this document argues from:

1. **Correctness under concurrency** — no duplicate dispatch across 2.09 million
   requests, including at the rate that broke everything else.
2. **Shape** — where the throughput knee is relative to a fixed load generator,
   and which step degrades first.
3. **Stability over time** — no drift across 16 minutes.

The deployed envelope is an open item. [Measuring it](#measuring-the-deployed-envelope)
says exactly how, and it is a 20-minute job once the API Gateway is applied.

---

## Results

All figures from the exported JSON in `evidence/reliability-operations/k6/`.
"RPS" in the profile name is **iterations** per second; each iteration issues
six HTTP requests (three tenant-config reads, a sale create, a pay, and a pay
retry), so HTTP throughput is roughly six times the iteration rate.

| Profile | Rate | HTTP req/s | Requests | Failed | p95 | checks | Dropped | Duplicate dispatch | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| smoke | 1 VU | 4 | 121 | 0% | 5.09 ms | 100% | 0 | **0** | pass |
| baseline | 5→60 stepped | 129 | 77,401 | 0% | 1.96 ms | 100% | 0 | **0** | pass |
| spike | 10→150→10 | 191 | 49,601 | 0% | 1.49 ms | 100% | 0 | **0** | pass |
| soak | 20 for 16 min | 120 | 115,207 | 0% | 2.06 ms | 100% | 0 | **0** | pass |
| step | 200 | 1,198 | 108,001 | 0% | 0.68 ms | 100% | 0 | **0** | pass |
| step | 400 | 2,397 | 216,007 | 0% | 0.49 ms | 100% | 0 | **0** | **pass — highest clean** |
| step | 600 | 3,583 | 322,921 | 0% | 21.08 ms | 100% | 181 | **0** | SLOs hold, generator drops |
| step | 800 | 4,314 | 413,992 | 3.18% | 182.76 ms | 96.62% | 1,857 | **0** | **fail** |
| capacity | 100→1500 ramp | 1,727 | 784,606 | 11.15% | 1014.42 ms | 88.28% | 99,764 | **0** | fail by design |

### Highest sustained rate where the SLOs hold

**400 iterations/s — roughly 2,400 HTTP requests/s — held for 90 seconds with
every threshold green**, including the POS-specific p95 < 400 ms on sale
creation.

600 is the honest grey zone. Every service-side threshold still passed there —
0% failed, p95 21 ms — but k6 dropped 181 iterations, meaning the generator
could not actually apply the rate it was asked for. On a single machine that is
not evidence about the service; it is evidence that the load generator and the
services under test are competing for the same CPU. **This is the strongest
reason the numbers above are a lower bound on the service and an upper bound on
this laptop.**

800 is an unambiguous fail: 3.18% of requests errored and checks fell to 96.62%.

### The result that actually matters

**Zero duplicate dispatches in 2,087,857 requests**, across every profile,
including at 800 RPS where 3.18% of requests were failing and at the capacity
ramp's breaking point where 11% were.

Every iteration pays a sale and immediately pays it again with the same sale ID.
POS answers `202` only on the call that genuinely dispatched an STK push; once a
payment is attached it answers `200` without touching Payments. A second `202`
would therefore be a second STK push against the same sale — a customer charged
twice.

Saturation is exactly when that failure would appear, and it did not, at any
rate tested. That is the capacity result worth defending: the system degrades by
getting slower and refusing requests, not by taking money twice.

---

## Bottleneck

**In this local configuration, the bottleneck is CPU on the shared machine**,
and the first thing to degrade is the write path.

At 800 RPS, sale creation p95 was 140 ms against a tenant-config read p95 that
stayed far lower. `sale_pay` degraded hardest of all — p95 2,642 ms on the
capacity ramp — which is expected: it is the only step that makes a
cross-service call (POS → Payments) rather than serving from local state, so it
absorbs both services' queueing.

**In the deployed configuration, the bottleneck will be somewhere else**, and
the design already names where: one `db.t4g.micro` shared by POS, Payments and
Commission. That is why:

- `devops-g2-rds-cpu-high` exists as saturation context rather than as a page.
- The runbook's POS-latency section says to check `DatabaseConnections` **before
  scaling out**, because more POS tasks means more connections to the same small
  instance — which makes a connection-bound problem worse.
- Cache-aside on `GET /tenants/:id/config` is the identified first fix: it is
  the read-heavy path, it is written rarely, and it is the one query that can be
  removed from the database's load without touching money state.

---

## Headroom

Against the traffic this system is actually built for, headroom is not the
constraint. A till serving one customer every 30 seconds generates well under
1 RPS; a tenant with ten active tills generates a few. Even the pessimistic
local figure of 400 iterations/s is three orders of magnitude above that.

The honest conclusion is that **TillFlow is not throughput-constrained at any
plausible demo or early-production load**, and effort spent optimising
throughput would be effort not spent on the things that are constrained:

- **`desired_count = 1` for both services.** There is no headroom of the kind
  that matters — the kind that survives losing a task. One unhealthy target is
  an outage, which is exactly what the `*-unhealthy-targets` alarms say in their
  impact line. Raising `desired_count` to 2 buys more real availability than any
  throughput work.
- **Single-AZ RDS and a single NAT gateway** (ADR 0002). An AZ outage exceeds
  RTO regardless of how much CPU headroom exists.

### Scaling metric, when it is needed

ECS service auto-scaling should track **ALB `RequestCountPerTarget`**, not CPU.
CPU is a lagging and ambiguous signal here — the ADOT sidecar shares the task's
CPU allocation, so a collector hiccup looks like application load. Request count
per target maps directly to the thing being scaled.

Task size stays at 256 CPU / 512 MB. The soak showed RSS oscillating between 33
and 203 MB for POS with no upward trend, so 512 MB is adequate with room; the
right change under load is more tasks, not bigger ones.

---

## Stability over time

The 16-minute soak at 20 iterations/s: 115,207 requests, 0% failed, p95 2.06 ms,
checks 100%, 0 dropped iterations.

RSS was sampled every 15 seconds throughout
([`k6/soak-memory.csv`](../evidence/reliability-operations/k6/soak-memory.csv)):

| Process | Min | Mean | Max |
|---|---|---|---|
| Payments | 17 MB | 36 MB | 82 MB |
| POS | 33 MB | 102 MB | 203 MB |

**No leak.** RSS sawtooths with garbage collection and returns to baseline; it
does not trend upward. This was worth checking specifically because both
services were running in-memory stores that accumulate every sale and payment
for the lifetime of the process — a genuine unbounded-growth risk in this test
configuration, and one the numbers show the collector absorbing at this rate and
duration.

Latency did not drift either: soak p95 (2.06 ms) is within noise of the baseline
p95 (1.96 ms) measured ten minutes of runtime earlier.

---

## Cost assumption

List prices, `us-east-2`, on-demand, per month. **Estimates from the published
rate card, not a measured bill.**

| Component | Assumption | Est. monthly |
|---|---|---|
| NAT Gateway | 1, always on, before data processing | ~$33 |
| ALB | 1, before LCU charges | ~$16 |
| **Synthetics canary** | **1/min = 43,200 runs at $0.0012** | **~$52** |
| RDS `db.t4g.micro` | single-AZ + 20 GB gp3 | ~$14 |
| ECS Fargate | 2 tasks at 0.25 vCPU / 0.5 GB | ~$18 |
| CloudWatch alarms | 13 at $0.10 | ~$1 |
| Custom metrics | 8 log-derived metrics at $0.30 | ~$2 |
| KMS | 1 customer-managed key for the alerts topic | ~$1 |
| Lambda, S3, DynamoDB, Secrets Manager | at this volume | <$2 |
| | | **~$139** |

### The finding worth raising

**The one-minute synthetic probe is the second-largest line item — more than the
database, and more than both application services combined.**

That is a real trade, and it should be a decision rather than an accident. The
brief specifies a one-minute probe, so it stays at one minute for the capstone.
But the argument for the sixty-second interval is detection latency, and it is
worth stating what is actually being bought:

| Interval | Monthly | Worst-case detection |
|---|---|---|
| 1 minute | ~$52 | ~3 min (2-of-3 datapoints) |
| 5 minutes | ~$10 | ~15 min |

Beyond the demo, five minutes would be defensible for a system whose RTO is 30
minutes — spending 38% of the RTO budget on detection is not obviously wrong,
and it saves more than the database costs. Changing it is one line in
`infra/main/synthetics.tf`.

The NAT gateway is the other line worth noting: it exists so private-subnet
tasks can reach Daraja and ECR. VPC endpoints for ECR and Secrets Manager would
reduce its data-processing charges, though not the hourly rate.

---

## Caching before and after

**Not yet measured, and deliberately not faked.**

The cache-aside layer is provisioned on a separate branch. Measuring its effect
locally would be worse than not measuring it: the local POS serves tenant config
from an in-memory `Map`, so putting a network round-trip in front of that would
make the "after" number *worse* than the "before" and prove nothing about the
deployed system. The benefit only exists relative to an RDS round-trip.

The measurement is meaningful only against the deployed environment, where the
before/after is "read from Postgres" versus "read from Valkey":

```bash
# before — POS_CACHE=off
SERVICE_AUTH_SECRET=<real> POS_BASE_URL=<api-gateway-url> k6 run -e STEP_RATE=50 load/k6/step.js
mv evidence/reliability-operations/k6/step-50.json evidence/reliability-operations/k6/step-50-nocache.json

# after — POS_CACHE=redis, same rate, same profile
SERVICE_AUTH_SECRET=<real> POS_BASE_URL=<api-gateway-url> k6 run -e STEP_RATE=50 load/k6/step.js
```

The metric to compare is `tillflow_tenant_config_duration` p95, not the blended
`http_req_duration` — the cache touches one step, and a blended figure would
dilute the effect with five uncached requests per iteration.

---

## Measuring the deployed envelope

Everything above is a local lower bound. Converting it into a real capacity
statement needs the API Gateway applied, and then:

```bash
export SERVICE_AUTH_SECRET=<the deployed secret>
export POS_BASE_URL=$(cd infra/main && terraform output -raw api_gateway_invoke_url)

k6 run load/k6/smoke.js                  # confirm the path works at all
k6 run load/k6/baseline.js               # 10 min — does the envelope hold at expected load
k6 run -e STEP_RATE=25 load/k6/step.js   # then walk the rate up
k6 run -e STEP_RATE=50 load/k6/step.js
k6 run -e STEP_RATE=100 load/k6/step.js
```

Start far lower than the local figures. The deployed path has a real database
and a real network on it, and the interesting number will be one or two orders
of magnitude smaller.

Watch the ECS and RDS saturation panels during the run — the brief's envelope
includes CPU < 70% and memory < 75%, and those cannot be observed from the load
generator's side at all. The dashboard draws both thresholds as annotation
lines for exactly this.
