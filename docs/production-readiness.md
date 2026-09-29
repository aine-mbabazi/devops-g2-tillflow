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
| Observability | Applied and proven — probe at 99.99%/7d, a real unplanned alarm delivered in 82s, drills 3 & 6 delivered both ways, Grafana live | No |
| Availability | `desired_count = 1`, single-AZ RDS, single NAT | **Yes** |
| Recovery | Rehearsed — drill 5 missed RTO/RPO narrowly, drill 4 exceeded RTO, drills 1-2 local-only | **Yes** |
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

### 1. Failure has been rehearsed — with real, narrow misses, not a clean sweep

All six game-day drills in [`runbook.md`](runbook.md) have been executed
against real code paths, and four against the live deployed stack. None of
this is claimed as a clean pass:

- **Drills 3 (platform failure) and 6 (abandoned payment/DLQ) are full
  passes** against the live stack, with alarms firing and recovering to
  Slack both ways.
- **Drill 4 (broken release) exceeded RTO** — total time from deploy start
  to a confirmed-good service was in the 30–36 minute range, at or past the
  30-minute target, not comfortably under it.
- **Drill 5 (restore) is a full mechanism pass but missed both timing
  targets narrowly:** RTO 1833s (30m33s), 33s over the 30-minute target;
  RPO 483s (8m03s), 2m48s over the 5-minute target. Measured for real, not
  asserted, and reported as missed rather than rounded favorably.
- **Drills 1–2 (uncertain payment, callback replay) are local-only**, run
  against real application code over a real ephemeral HTTP server rather
  than the deployed edge — `DARAJA_MODE=fake` on the deployed Payments task
  makes the specific failure each drill needs structurally undriveable over
  the public API (`FakeDarajaClient.simulateOutcome` is JS-only, not
  reachable over HTTP), so they could not be moved to the live stack without
  adding a test-only trigger.

**RTO (30 min) and RPO (5 min) are now measured for the restore path, not
just design intent** — and both were missed, by a small margin. That is a
sharper, more honest signal than "not measured": this instance size runs
close to or slightly over both targets, not comfortably inside them.

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

### 3. Observability is applied and has fired for real

Alarms, dashboards, the alert path and the synthetic probe are applied, not
just written. The evidence:

- **The synthetic probe has run 9,819 times over 7 days at 99.99% success**
  (one `payments-ready` 503 in that window). See
  [`evidence/reliability-operations/probe/`](../evidence/reliability-operations/probe/).
- **A real, unplanned alarm delivered to Slack in 82 s** — not a drill, an
  actual firing-to-notification round trip. Drill 3 (platform failure) and
  drill 6 (abandoned payment/DLQ) both delivered alarms to Slack in both
  directions (firing and recovery). See
  [`evidence/reliability-operations/alarms/`](../evidence/reliability-operations/alarms/).
- **The Grafana dashboard renders live data**, captured against a running
  CloudWatch datasource — see
  [`evidence/reliability-operations/grafana/`](../evidence/reliability-operations/grafana/)
  and the k6-driven load evidence in
  [`evidence/reliability-operations/k6/`](../evidence/reliability-operations/k6/).

This closes the "wired but unproven" gap this section used to describe. It
does not mean observability has no limitations.

**The alert-delivery watchdog routes through the same Slack path it
monitors.** `devops-g2-alert-delivery-failing` exists to catch a silent
notifier, but its own OK/ALARM notifications are delivered through that
same notifier — so when Slack delivery itself is broken, the watchdog's
attempt to say so is also broken, and it re-triggers itself on every
evaluation instead of surfacing the outage. This is not hypothetical: it
happened for 19 hours after G5 (see
[`evidence/reliability-operations/alarms/post-rebuild-slack-test/`](../evidence/reliability-operations/alarms/post-rebuild-slack-test/README.md)).
Follow-up: route this one alarm to a separate non-Slack SNS topic (email),
so it stays visible when Slack itself is the thing that's down.

### 4. Security gaps worth naming

| Gap | Risk | Mitigation today |
|---|---|---|
| **No TLS in the VPC.** API Gateway terminates HTTPS, then forwards over plain HTTP to the ALB and on to the tasks. | Traffic including `X-Service-Auth` tokens and payment payloads is readable by anything on the VPC path. | Private subnets, security groups scoped to peers. Not sufficient for real card/mobile-money traffic. |
| **Service auth is a shared HMAC secret**, distributed via Secrets Manager. | One secret compromise impersonates every caller for every tenant. No per-caller identity, no rotation story. | Short 5-minute token window; tenant is bound into the signature. |
| **No end-user authentication at all.** | The system authenticates *services*, not the attendant or owner. `services/web` is a real deployed API shell (`docs/architecture.md`), but it carries no user identity layer of its own — every route requires the same shared service-auth token POS and Payments require. | None. This is a product gap, not a hardening gap. |
| **No WAF on API Gateway.** | Public entry point with no rate limiting or request filtering. | None. |
| **`skip_final_snapshot = true`, `deletion_protection = false` on RDS.** | `terraform destroy` silently discards the payment ledger. | Deliberate for a demo that tears down between gates. Both must flip before real data exists. |
| **Database TLS uses `rejectUnauthorized: false`.** | Connections are encrypted but the server certificate is not verified — a machine-in-the-middle within the VPC presenting a different cert would not be detected. | Traffic to RDS is encrypted, not plaintext. Follow-up: load the RDS CA bundle and verify — see the 2026-09-29 SSL entry in [`scar-log.md`](scar-log.md). |

### 5. Data protection

- Backups: automated, 7-day retention, PITR, window placed after the daily
  close so a restore point always contains a complete commission run.
- **Restored once (drill 5), and the restore itself missed RTO/RPO narrowly** —
  see point 1. A single restore, on one instance size, is evidence, not a
  guarantee it holds under different conditions.
- The restore procedure includes a step that is easy to skip and expensive to
  skip: re-querying Daraja for payments that were `pending` at the restore
  point. A restore rewinds TillFlow's record of the world, not the provider's.

### 6. Destroy and rebuild — gated, and now exercised once

A real `terraform destroy` fails today, on purpose: the four S3 buckets
(`artifacts`, `logs`, `backups`, `evidence`) are versioned with no
`force_destroy`, and the four ECR repositories are `IMMUTABLE` with no
`force_delete` — either blocks destroy on any non-empty resource. Both are now
gated behind Terraform variables (`bucket_force_destroy`, `ecr_force_delete`,
`infra/main/variables.tf`), defaulting to `false` so an ordinary destroy still
fails loudly rather than silently discarding versioned objects or shipped
images. RDS is not a blocker — `skip_final_snapshot = true` and
`deletion_protection = false` (§4) mean it destroys cleanly already.

**Teardown sequence, when actually intended:**

```bash
cd infra/main
TF_VAR_bucket_force_destroy=true TF_VAR_ecr_force_delete=true terraform apply

# Confirm before destroying, not after:
aws s3api list-buckets --query 'Buckets[?starts_with(Name,`devops-g2-`)].Name'
aws ecr describe-repositories --query 'repositories[?starts_with(repositoryName,`devops-g2/`)].repositoryName'

terraform destroy
# infra/bootstrap only if the state bucket itself must go, and only once it is empty
```

**A real destroy → rebuild has been executed (G5, 28/29 Sep 2026).** Destroy:
12m05s (157 resources). Rebuild to a confirmed live `200` at the new API
Gateway URL: 46m50s, including diagnosing and fixing two real blockers along
the way (stale S3 `import` blocks, Secrets Manager's pending-deletion window)
and an RDS SSL-enforcement mismatch that needed an app-level fix. Post-rebuild
smoke passed (`load/k6/smoke.js`, 53 requests, 0% failed, 0 duplicate
dispatches) and the tag audit passed (115 resources, 0 violations). Full
timeline, every timing, and the honest caveats — including what is *not* yet
fixed (the Secrets Manager `recovery_window_in_days` gap) and the SSL
trade-off (encrypted, not authenticated; CA-bundle verification is a
follow-up) — are in
[`evidence/reliability-operations/g5-destroy-rebuild.md`](../evidence/reliability-operations/g5-destroy-rebuild.md).

---

## Operational readiness

| Question | Answer |
|---|---|
| Can we tell if it is down? | Yes — external probe at 1-minute frequency, the only alarm with `treat_missing_data = breaching`, running at 99.99% success over 7 days. |
| Can we tell if it is wrong? | Yes — money-correctness alarms at a threshold of zero, from log-derived metrics. These catch failures no HTTP metric would show. |
| Does an alert say what to do? | Yes — nine-field contract, owner and first safe action per alarm, enforced in CI by the runbook-anchor check. |
| Can we roll back? | Yes — automated on post-deploy smoke failure, and exercised for real (drill 4): a deliberately broken release triggered automated rollback, which succeeded but took 30-36 minutes, at or past the RTO target. |
| Do we know our limits? | Partly — the local envelope is measured; the deployed envelope is not. Commands to measure it are in the capacity model. |
| Who is on call? | Nobody. There is no rotation, and the Slack contract names an owner per alarm rather than a duty engineer. |

---

## If this were going live, in order

1. **Close the drill 4 and drill 5 timing gaps.** Both are executed, real
   evidence, and both missed their RTO/RPO target narrowly — worth
   understanding why (instance size, wait-timeout tuning) before trusting
   the targets on a real incident.
2. **`desired_count = 2`.** Cheapest real availability win available.
3. **Fix the alert-delivery watchdog's self-triggering loop** — route it to
   a non-Slack SNS topic (email) so it stays visible precisely when Slack
   itself is down, the one condition it exists to catch.
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
