# Production readiness review — TillFlow

DRI: @mercykilonzo (Reliability + operations, CI/CD + golden path), with the
per-area rows owned by their own DRIs per [`ownership.md`](ownership.md).

This is a review, not a certificate. The honest summary is at the top and the
things that would stop a real launch are named as such.

**Verdict: not production-ready.** It is demo-ready for a graded capstone, and
the gap between those two is written down below rather than glossed.

---

## Summary

| Area | State | Blocking a real launch? |
|---|---|---|
| Money correctness | Strong — idempotency at two levels, reconciliation-only resolution, invariants under load | No |
| Infrastructure as code | Strong — everything in Terraform, plan/apply gated, tagged | No |
| CI/CD and golden path | Good — PR checks, scans, SBOM, digest-pinned deploys, post-deploy smoke + rollback | No |
| Observability | Wired but unproven — alarms, dashboards and probe exist in code, none has ever fired | **Yes** |
| Availability | `desired_count = 1`, single-AZ RDS, single NAT | **Yes** |
| Recovery | Documented, never rehearsed | **Yes** |
| Security | Good baseline; gaps in transport and authz named below | **Yes** |

---

## What is genuinely solid

**Money handling.** This is the strongest part of the system, and it is the
part that matters most.

- Idempotency is enforced twice: a `(tenant_id, idempotency_key)` unique
  constraint, plus a partial unique index permitting only one *active* attempt
  per sale. Failed attempts stay in the audit history and can be retried with a
  fresh key.
- A timeout is never treated as a decline. Uncertain state stays `pending` and
  is resolved by querying Daraja, never by retrying.
- Callbacks are not trusted: an inbound callback triggers a provider query, and
  the query's answer is what transitions state. A contradicting callback is
  logged as `callback_conflict` and the stored state is preserved.
- Commission cannot call Daraja directly — enforced by a structural test, not
  convention.
- Proven under load: **2,087,857 requests across nine k6 profiles, zero
  duplicate dispatches**, including at the rate where 11% of requests were
  failing. See [`capacity-model.md`](capacity-model.md).

**Reproducibility.** Every resource is Terraform. The apply is gated on a
protected environment and applies a saved plan, so what a reviewer approved is
what reaches AWS. Images deploy by digest, never by tag, and the post-deploy
smoke asserts the running digest equals the one the pipeline built.

**Supply chain.** Secret, dependency and IaC scanning on every PR, failing on
fixable HIGH/CRITICAL. SBOMs generated from the shipped image by digest.
Registry-level enhanced scanning re-evaluates images as new CVEs land.

---

## What would stop a real launch

### 1. No failure has ever been rehearsed

Every recovery procedure in [`runbook.md`](runbook.md) is written and none has
been executed. All five game-day drills are specified with falsifiable
hypotheses; zero have run.

**RTO (30 min) and RPO (5 min) are design intent, not measurements.** They are
derived from how the mechanisms work, not from a timed restore. A recovery
objective nobody has timed is a guess with a number attached.

### 2. Single points of failure, by choice

- `desired_count = 1` for both services. One unhealthy target is an outage, not
  a degradation — which is why the `*-unhealthy-targets` alarms say exactly
  that in their impact line. **Raising this to 2 is the single highest-value
  availability change available**, and it costs about $9/month.
- Single-AZ RDS and a single NAT gateway (ADR 0002). An AZ outage exceeds RTO
  regardless of anything else in this document.
- One `db.t4g.micro` shared by all three services, with storage autoscaling
  disabled. At zero free storage every write fails simultaneously.

These are recorded, costed trades rather than oversights — but they are the
reason the verdict above is what it is.

### 3. Observability is wired, not working

Alarms, dashboards, the alert path and the synthetic probe all exist in
Terraform. **None has ever fired, because nothing has been applied.** No Slack
message has been delivered, the probe has never run, and Grafana — now
provisioned on Fargate with its dashboard loaded from the repo — has never been
rendered.

Until one apply succeeds, the operational posture is "we believe we would find
out", which is not the same as knowing.

### 4. Security gaps worth naming

| Gap | Risk | Mitigation today |
|---|---|---|
| **No TLS in the VPC.** API Gateway terminates HTTPS, then forwards over plain HTTP to the ALB and on to the tasks. | Traffic including `X-Service-Auth` tokens and payment payloads is readable by anything on the VPC path. | Private subnets, security groups scoped to peers. Not sufficient for real card/mobile-money traffic. |
| **Service auth is a shared HMAC secret**, distributed via Secrets Manager. | One secret compromise impersonates every caller for every tenant. No per-caller identity, no rotation story. | Short 5-minute token window; tenant is bound into the signature. |
| **No end-user authentication at all.** | The system authenticates *services*, not the attendant or owner. `services/web` is a real deployed API shell (`docs/architecture.md`), but it carries no user identity layer of its own — every route requires the same shared service-auth token POS and Payments require. | None. This is a product gap, not a hardening gap. |
| **No WAF on API Gateway.** | Public entry point with no rate limiting or request filtering. | None. |
| **`skip_final_snapshot = true`, `deletion_protection = false` on RDS.** | `terraform destroy` silently discards the payment ledger. | Deliberate for a demo that tears down between gates. Both must flip before real data exists. |

### 5. Data protection

- Backups: automated, 7-day retention, PITR, window placed after the daily
  close so a restore point always contains a complete commission run.
- **Never restored.** See point 1.
- The restore procedure includes a step that is easy to skip and expensive to
  skip: re-querying Daraja for payments that were `pending` at the restore
  point. A restore rewinds TillFlow's record of the world, not the provider's.

---

## Operational readiness

| Question | Answer |
|---|---|
| Can we tell if it is down? | Yes, once applied — external probe at 1-minute frequency, the only alarm with `treat_missing_data = breaching`. |
| Can we tell if it is wrong? | Yes — money-correctness alarms at a threshold of zero, from log-derived metrics. These catch failures no HTTP metric would show. |
| Does an alert say what to do? | Yes — nine-field contract, owner and first safe action per alarm, enforced in CI by the runbook-anchor check. |
| Can we roll back? | Yes — automated on post-deploy smoke failure for both services, and documented by hand in the runbook. Never exercised against a genuinely broken release. |
| Do we know our limits? | Partly — the local envelope is measured; the deployed envelope is not. Commands to measure it are in the capacity model. |
| Who is on call? | Nobody. There is no rotation, and the Slack contract names an owner per alarm rather than a duty engineer. |

---

## If this were going live, in order

1. **Run the five game-day drills** and record measured RTO/RPO. Everything
   else on this list is a guess until this happens.
2. **`desired_count = 2`.** Cheapest real availability win available.
3. **Apply, and confirm one alert round-trips to Slack** — firing and recovery.
4. **TLS end to end**, or an explicit written acceptance of plaintext inside
   the VPC signed off by whoever owns the risk.
5. **Flip `deletion_protection` and `skip_final_snapshot`** before any real
   money moves.
6. **Multi-AZ RDS and a second NAT**, or an explicit acceptance that an AZ
   outage is a multi-hour outage.
7. **An on-call rotation**, because an alert with an owner and no rota is an
   alert that waits until morning.

---

## Review record

| Date | Reviewer | Outcome |
|---|---|---|
| 2026-09-19 | @mercykilonzo | Not production-ready. Demo-ready. Blocking items listed above; none is a surprise or a defect, all are either unrehearsed recovery or recorded cost trades. |
