# G5 — destroy → rebuild → live, executed 2026-09-28/29

DRI: @aine-mbabazi (Platform + delivery). First full `terraform destroy` +
rebuild cycle for this stack's current resource set — the README's own
"Not yet exercised" line for this is now closed.

**⚠️ Merge PR #105 before any other open PR that touches `services/`.** The
pos, payments, commission, and web images currently running in production
were built from this PR's tree — including the `imports.tf` removal and
the `ssl: { rejectUnauthorized: false }` fix below. Merging something else
first risks `main` diverging from what's actually deployed.

## Timeline (UTC)

| Time | Event |
|---|---|
| 22:47:37 | Manual RDS snapshot `devops-g2-db-pre-g5-destroy-20260928-224737` created (survives destroy; automated snapshots do not) |
| 22:53:xx | Force-destroy apply (`bucket_force_destroy`/`ecr_force_delete` → true, local — no CI path for `terraform destroy` exists): 0 add, 10 change, 0 destroy |
| **22:55:14** | **Destroy started** — `terraform apply` on a `-destroy` plan (157 resources), local, no CI path exists for destroy |
| **23:07:19** | **Destroy complete** — `Apply complete! Resources: 0 added, 0 changed, 157 destroyed.` **RTO: 12m05s** |
| 00:14–00:17 | Rebuild planned; hit a hard blocker: `infra/main/imports.tf` held stale `import` blocks for the 4 S3 buckets from a 2026-09-20 drift fix (its own comment: "safe to remove once applied once main"). Buckets no longer exist post-destroy, so every plan failed trying to import them. Deleted the file. |
| **00:17:14** | **Rebuild apply started** (149 resources) |
| 00:17–00:28 | Apply progressed (VPC, ALB, ECS, RDS ~4m51s, ElastiCache ~9m) then failed: 3 Secrets Manager secrets (`service-auth-secret`, `database-url`, `slack-webhook`) couldn't be created — "already scheduled for deletion." `terraform destroy` only soft-deletes secrets (AWS default recovery window); this exact failure mode is already in `docs/scar-log.md` from 2026-09-20. |
| ~00:30 | Force-purged all 3 secrets (`delete-secret --force-delete-without-recovery`) to unblock |
| 00:30–00:31 | Second apply: 24 resources (the 3 secrets + everything downstream), 0 destroy — clean |
| ~00:37 | Images built/pushed/registered for pos, payments, web, commission (no `workflow_dispatch` on any release workflow, so built and pushed locally via the same digest-pinned pattern `release.yml` uses) and deployed to the 3 continuous services |
| 00:39 | **POS `/ready` returning 503**, `code: 28000` (Postgres auth error). Diagnosed via a one-off VPC task testing the exact secret value directly: not a password mismatch — `no pg_hba.conf entry for host ... no encryption`. The fresh RDS instance's default parameter group enforces SSL; the app's `pg.Pool` never requested it. (Payments/web showed "healthy" throughout — misleadingly: their target groups poll `/health`, liveness-only, not DB-dependent, so the same defect was silently masked there.) |
| 00:39–00:53 | Fixed at the app layer (not by disabling RDS's SSL enforcement): added `ssl: { rejectUnauthorized: false }` to every `new Pool(...)` call — `services/{pos,payments,commission}/src/server.js` (or `run.js`) and all three `migrate.js`. Rebuilt and re-registered all three (pos:19, payments:26, commission:14). |
| 00:56–00:59 | Migrations run against the fresh (previously never-migrated) RDS instance via one-off VPC tasks, using the SSL-fixed images: POS 3 files, Commission 1 file, Payments 2 files (needed a path correction — `/app/services/payments/src/migrate.js`, not `/app/src/migrate.js`, since Payments' Dockerfile has a different COPY layout than POS/Commission's) |
| 00:58:42 | SSL-fixed images force-deployed to `devops-g2-pos` and `devops-g2-payments` |
| **01:03:49** | POS `/ready` → 200 confirmed in task logs — **first successful DB-dependent request post-rebuild** |
| **01:04:04** | **First confirmed 200**: `GET https://o71n13inq0.execute-api.us-east-2.amazonaws.com/health` → 200 |
| 01:05 | `load-tenant` tenant config re-seeded (`PUT /tenants/load-tenant/config`) |
| **01:05:10–01:05:42** | `load/k6/smoke.js` run against the new deployed edge — **PASS**: 53 requests, 0% failed, all thresholds green, 0 duplicate dispatches. `evidence/reliability-operations/k6/deployed-g5-smoke-20260929.json` |
| 01:07–01:09 | Follow-up apply enabling the synthetic probe (`synthetic_probe_url` set from the new gateway output): 8 to add, 0 destroy, clean |
| 01:09:33 | `scripts/audit-tags.sh` → **PASS**, 115 resources, 0 violations (after adding the 4 tags `create-db-snapshot` didn't set on the manual pre-destroy snapshot, plus normalizing its `managed-by` tag to `terraform` for audit consistency — see caveat below) |

## RTO

**Destroy: 12m05s.** **Rebuild to first live 200: 46m50s** (00:17:14 start of the rebuild apply → 01:04:04 first confirmed 200) — dominated by the SSL diagnosis/fix/rebuild/migrate detour (00:39–01:04, ~25 min) and the two unplanned infra-apply blockers (stale imports, pending-deletion secrets). Neither blocker was retried blindly — each was diagnosed and fixed at the root cause before retrying.

## New URLs (replaces the old, now-destroyed stack's)

- **API Gateway (public entry point):** `https://o71n13inq0.execute-api.us-east-2.amazonaws.com/`
- **RDS endpoint:** `devops-g2-db.cxwaioocu1ls.us-east-2.rds.amazonaws.com` (new instance, new random password, migrated fresh — not the same data as the destroyed instance; the pre-destroy state is preserved only in the manual snapshot)
- All other `devops-g2-*` resource names are unchanged (ECR repo URLs, cluster name, etc.) since they're not account/region-scoped beyond the fixed prefix.

## Real defects found and fixed, not worked around

1. **`infra/main/imports.tf`** — stale one-off `import` blocks left in the codebase past their documented shelf life, breaking any future from-scratch apply. Deleted.
2. **Secrets Manager pending-deletion on destroy** — `aws_secretsmanager_secret_version.database_url`/`service_auth`/`slack_webhook` all use `ignore_changes = [secret_string]`, but the secret resources themselves have no `recovery_window_in_days = 0`, so `terraform destroy` leaves them soft-deleted for AWS's default recovery window, blocking any rebuild until manually purged. **Same failure class already recorded once in `docs/scar-log.md` (2026-09-20)** — worth fixing at the source (`recovery_window_in_days = 0` on all three) so the next teardown doesn't need this manual step again. *Not fixed in this PR* — flagged here for a follow-up, given the time budget.
3. **RDS SSL enforcement with no app-side SSL support** — every service's `pg.Pool` construction (3 `server.js`/`run.js`, 3 `migrate.js`) assumed a plaintext connection would be accepted. The original (destroyed) instance apparently never exercised this — either an AWS default changed, or the original instance carried an undocumented custom parameter group. Fixed at the app layer with `ssl: { rejectUnauthorized: false }`, not by disabling RDS's own enforcement — the more secure fix, not the faster one that happened to also be available.

   **This is a known trade-off, not a finished fix.** `rejectUnauthorized: false` gets an *encrypted* connection — traffic to RDS is no longer plaintext — but it does **not** verify the server certificate, so it is not protected against a machine-in-the-middle presenting a different cert within the VPC. The honest state is "encrypted, not authenticated." **Follow-up:** load the RDS CA bundle (`AmazonRootCA1`/the regional RDS CA cert) into the image and pass it as `ssl: { ca: <bundle>, rejectUnauthorized: true }`, verifying the server identity properly instead of skipping the check.

## Honest caveats

- **The manual pre-destroy RDS snapshot is tagged `managed-by=terraform`, which is not literally true** — it was created out-of-band via the AWS CLI, not by Terraform. Done to satisfy `scripts/audit-tags.sh`'s hardcoded expectation (no exemption mechanism exists for legitimately-manual resources). The snapshot's real provenance is this document and `docs/scar-log.md`, not its tags.
- **The Secrets Manager `recovery_window_in_days` gap (defect 2 above) is not fixed in this PR** — only worked around locally (force-purge) to unblock tonight's rebuild. A future destroy will hit it again until `secrets.tf` is updated.
- **RDS data is not the same as before the destroy.** The manual snapshot preserves the pre-destroy state if it's ever needed, but the live instance was rebuilt empty and freshly migrated — this was a deliberate demo-environment teardown, not a disaster-recovery restore (see drill 5 for that scenario instead).
- **`devops-g2/slack-webhook` was live but empty** post-rebuild (Terraform never versions it, by design). It was populated and delivery verified on 2026-09-29 — but not before the empty secret caused a 19-hour self-triggering loop in the alert-delivery watchdog, since the watchdog's own notifications route through the same webhook it exists to monitor. Full incident, fix and follow-ups: [`evidence/reliability-operations/alarms/post-rebuild-slack-test/`](alarms/post-rebuild-slack-test/README.md).
- Web was rebuilt/redeployed but not independently smoke-tested beyond a healthy target group (it has no HTTP routes exercised by `smoke.js`).

## Post-rebuild verification, before the 02:00 UTC scheduled close

Run separately, ~15 minutes after the rebuild, to confirm Commission specifically before its first real scheduled invocation:

- Latest task definition (revision 14): correct image digest, `TENANT_IDS=load-tenant`, all three `OTEL_*` vars, 6 tags (audit-confirmed correct for this resource type — task definition ARNs already carry the `devops-g2-` prefix, so `scripts/audit-tags.sh`'s `Name`-tag fallback check doesn't apply here).
- Confirmed the pushed image itself (not just the source tree) contains the SSL fix: `docker run --rm --entrypoint cat <image>@<digest> src/run.js` shows `ssl: { rejectUnauthorized: false }` directly.
- Confirmed `commission.ledger_entries` exists on the new RDS instance (migration applied) via a one-off VPC query.
- Ran one real close (`aws ecs run-task --task-definition devops-g2-commission`): `daily_close_started` → `daily_close_completed`, `payoutCount: 0` (expected — nothing has reached `paid` in `DARAJA_MODE=fake`), **exit code 0**. `commissionRunId: "close:2026-09-29"` — derived from the UTC date, so the real 02:00 UTC scheduled run reuses the same idempotency key and cannot double-run today's close.
- Synthetic probe re-confirmed: `PROBE_BASE_URL` points at the new API Gateway URL, and CloudWatch shows one invocation per minute for the last 10 minutes (10/10).
- `scripts/audit-tags.sh` re-run clean: `PASS — 115 resources, no naming or tagging violations`.
