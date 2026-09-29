# Scar Log — TillFlow (Group 2)

## 2026-09-11 — Bucket naming collision in shared cohort account
The planned Terraform state bucket name `devops-g2-tfstate-<account-id>` collided
with a pre-existing bucket from an unrelated lab exercise already present in the
shared AkiraChix cohort AWS account (dated 2026-08-27, unrelated to TillFlow).
Renamed to `devops-g2-tillflow-tfstate-<account-id>` to avoid ambiguity.
Lesson: in a shared multi-cohort account, include the project name (not just
the group number) in globally-unique resource names from the start.

## 2026-09-12 — SSO role lacked IAM write permissions for OIDC setup
Our SSO role (`DevOpsCohort-group2-us-east-2`) does not have
`iam:CreateOpenIDConnectProvider` on the shared AkiraChix account — a
deliberate guardrail preventing groups from creating new trust relationships.
Discovered while setting up GitHub Actions OIDC authentication for CI/CD.

Resolved by referencing the account's existing GitHub OIDC provider via a
Terraform data source (`data "aws_iam_openid_connect_provider"`) instead of
creating a new one — role creation itself was permitted, just not provider
creation. Learned this approach from another group (G10) who hit the same
wall.

Follow-up permission gaps also surfaced once the CI role started running
real `terraform plan` commands: the role needed additional read/describe/
list-tags permissions across EC2, ECS, ECR, ELB, IAM, Logs, DynamoDB, KMS,
and S3 for Terraform's state-refresh step to succeed — these were added
incrementally as each specific `AccessDenied` error surfaced.

Lesson: in a shared multi-cohort AWS account, expect IAM write actions to
be restricted even for otherwise-broad roles. Check whether required
account-level primitives (like an OIDC provider) already exist before
assuming you need to create them.

## 2026-09-20 — S3 bucket state drift blocked every Infra Apply run

`Infra Apply` failed on every run for several days with
`BucketAlreadyOwnedByYou` on the artifacts/logs/backups/evidence buckets —
they existed in the account but were never tracked in this stack's Terraform
state, most likely from an early local apply (proving out the S3 ADR/bucket-
policy evidence) run before the OIDC apply pipeline existed, against a state
target that was never merged back. Every apply since died on those four
resources before anything downstream could be trusted as reconciled.

Fixed with Terraform 1.5+ `import` blocks (`infra/main/imports.tf`) rather
than a manual `terraform import` outside CI — reviewable in a PR, applied
through the same OIDC pipeline. Surfaced two further permission gaps in the
process, both fixed the same way (code + a one-off manual IAM patch to
unblock the very apply that would otherwise grant the permission to itself):

- The read-only plan role (`devops-g2-ci-deploy`) had `s3:GetBucket*` but not
  `s3:ListBucket` — AWS authorizes `HeadBucket` (which every `aws_s3_bucket`
  read/import calls) via `s3:ListBucket` specifically, not the `Get*`
  actions. Without it, the 403 gets misreported by the provider as "bucket
  does not exist," which looks identical to the original drift bug.
- The apply role (`devops-g2-ci-apply`) could create/modify these buckets
  but lacked `s3:GetBucketPolicy`, which the provider's read path calls
  unconditionally even though none of these buckets have a managed policy
  resource.

Lesson: an `import` block's `id` must be a static literal — it errors if it
references a `local` derived from a data source, even one that's `apply`-time
constant. And a role that has only ever needed to plan/apply against
resources it already knows about will surface new gaps in a very specific
place — right when a genuinely new resource type or state-reconciliation
path is introduced — one action at a time, not all at once.

## 2026-09-20 — Post-deploy smoke counted a normal draining target as a failed deploy

`Deploy Payments` rolled back a fully healthy release: ECS reported the
rollout `COMPLETED`, but the smoke check's single point-in-time
`describe-target-health` call caught the *outgoing* task's target still in
`draining` state (neither target group overrides `deregistration_delay`, so
both default to AWS's 300s) and treated it as a failure. A first fix
(retrying the check for up to 120s) still didn't help — a retry loop doesn't
end the outgoing task's drain window, it just polls longer inside it. The
actual fix was narrowing what counts as bad: only `unhealthy` / `unavailable`
states fail the check now, with a separate requirement that at least one
target is `healthy`.

Lesson: "the rollout is done" (ECS) and "the target group has caught up"
(ALB) are two different clocks, and at `desired_count = 1` a rolling
deployment always has a brief window with both an old (`draining`) and new
target registered simultaneously — that is success, not a symptom, and a
health check written as "everything must be `healthy`" will misread it as
the opposite every time.

## 2026-09-20 — Game day drills 1 & 2 executed

Uncertain payment and callback replay (`docs/runbook.md#game-day-drills`),
run against the real `app.js` / `payment-store.js` /
`reconciliation-queue.js` code over real HTTP on an ephemeral local server.
Both pass — see `evidence/reliability-operations/README.md#game-day` and the
transcripts in `evidence/reliability-operations/game-day/`.

Confirmed directly, not assumed: a dispatch that times out before Daraja
returns a provider ID can *never* be resolved by the automated reconciler —
`reconciliation-queue.js`'s `processMessage` explicitly refuses to guess
without an ID to query. That's not a gap; it's why the DLQ / "query Daraja
directly" procedure exists. The drill script plays that human step directly
rather than pretending the automated path alone closes the loop.

Drills 3 (platform failure), 4 (broken release) and 5 (restore) still need
the live AWS stack — desired_count=1 ECS service, RDS snapshot, a real
deploy to break — and have not been run yet.

## 2026-09-20 — Infra Apply partially failed deploying web: missing iam:UpdateAssumeRolePolicy

Deploying `services/web` as a real ECS service required adding
`release-web.yml` to `github_actions_deploy`'s OIDC trust policy
(`job_workflow_ref` allow-list) alongside the other release workflows. The
apply got through every new web resource (ECR repo, IAM roles, task
definition, ALB target group/listener rule, ECS service all created
successfully) and then failed on that one trust-policy update:
`AccessDenied: iam:UpdateAssumeRolePolicy`. `release-web.yml` then failed
its own OIDC step immediately after, since the role it needed to assume
still didn't trust it.

Root cause: `GroupScopedIAM`'s existing `iam:UpdateRole` only covers a
role's description and max-session-duration — changing its *trust policy*
(who may assume it) is a distinct action, `iam:UpdateAssumeRolePolicy`,
that the apply role had never needed until this PR, because every prior
`GroupScopedIAM` change had only ever touched an inline policy or created a
brand-new role, never edited an existing role's trust relationship.

Fixed by adding `iam:UpdateAssumeRolePolicy` to `GroupScopedIAM`, scoped to
the same `role/devops-g2-*` resource prefix as everything else in that
statement.

Lesson: same shape as the S3 `ListBucket`/`GetBucketPolicy` gaps from
earlier this week — a role that has only ever needed a subset of an AWS
service's actions surfaces a new, narrowly specific gap exactly when a
genuinely new *kind* of change (not just a new resource) is introduced, one
action at a time.

## 2026-09-20 — Destroying untracked drift exposed a second, larger read gap

The same apply above also destroyed `aws_iam_role_policy_attachment
.github_actions_readonly` — a `ReadOnlyAccess` managed-policy attachment on
`devops-g2-ci-deploy` that existed in AWS but was never written into
`github-oidc.tf`. Untracked drift, and Terraform correctly reconciled it
away since nothing in configuration asked for it.

The very next PR's `terraform plan` (same `ci-deploy` role, used by both
`pr.yml` and `infra-apply.yml`'s Plan job) then failed refreshing the S3
buckets: `AccessDenied: s3:GetAccelerateConfiguration`. `ReadOnlyAccess` had
been silently backstopping every read this role's own itemized
`TerraformReadForPlan` list never actually covered. With it gone, the
role's *real* permission set is exposed for the first time — and it was
short three S3 read actions that don't follow the `GetBucket*` naming
pattern the existing wildcard matches: `GetAccelerateConfiguration`,
`GetObjectLockConfiguration`, `GetReplicationConfiguration`.

Fixed by adding those three explicitly.

Lesson: an untracked, broad, manually-attached policy does not just violate
least-privilege on paper — it actively hides how incomplete the
Terraform-managed policy underneath it really is, and the gap only surfaces
at the worst possible time: the moment something finally removes the
crutch. Worth an explicit periodic check for drift like this rather than
waiting to discover it this way again.

## 2026-09-21 — Manual `put-role-policy` patch to unblock a PR predates its own fix landing on `main`

While PR #66 (which already carried the fix above, commit `930eeca`, on its
own branch) was open, `devops-g2-ci-deploy`'s `TerraformReadForPlan`
statement on `main` still lacked the same three S3 actions — that commit
hadn't merged yet. A blocked PR's `terraform plan` hit the identical
`AccessDenied: s3:GetAccelerateConfiguration` failure, and aine-mbabazi
patched the live role directly via `aws iam put-role-policy` from
CloudShell to unblock it, instead of waiting for #66 to merge.

The patch happened to add exactly the three actions `930eeca` already
codified, so it didn't conflict with that branch. But `aws_iam_role_policy`
replaces the entire inline document on every apply, and nothing on `main`
asked for these actions yet — the next `infra-apply.yml` run sourced from
`main` (unrelated to #66) would silently overwrite the live document back
to the old, narrower one, and re-fail the next PR's plan the same way,
looking like a fresh regression instead of a known, already-fixed gap.

Lesson: a manual live patch that matches an *unmerged* branch's Terraform
code is not a fix, it's a countdown — it survives only until the next
unrelated `apply` from `main` reasserts the old document. Merge and apply
the branch that already has the change instead of patching the live
resource by hand, even when the patch is byte-for-byte what the pending
code would produce.

## 2026-09-20 — Game day drill 4 (broken release) exceeded RTO, and the rollback's own success check is unreliable

PR #67 deliberately broke POS's `GET/HEAD /health` (always 500) and merged
to `main` at 23:22:18Z, triggering `release-pos.yml`.

Timeline:
- 23:22:59Z — deploy started (`aws-actions/amazon-ecs-deploy-task-definition`,
  `wait-for-service-stability: true`).
- 23:48:37Z — the wait timed out: `{"state":"TIMEOUT","observedResponses":
  {"200: OK":9},"reason":"Waiter has timed out"}`. The new revision never
  passed ECS's own container healthcheck (`wget --spider .../health`), so it
  never reached a stable rollout. 26 minutes elapsed at this point.
- 23:48:37Z — "Roll back on failure" fired immediately: forced redeploy to
  the previous task definition (`devops-g2-pos:13`), then its own
  `aws ecs wait services-stable` call.
- 23:58:34Z — that second wait **also** timed out: `aws: [ERROR]: Waiter
  ServicesStable failed: Max attempts exceeded`. 36 minutes total elapsed,
  and the workflow ended in failure with no confirmed-good signal from
  either wait.
- A manual `describe-services` check shortly after showed the service was in
  fact fine: `status: ACTIVE`, `running: 1/1`, one `PRIMARY` deployment on
  `devops-g2-pos:13`, `rolloutState: COMPLETED`, `failedTasks: 0`. The
  rollback had actually succeeded; the wait's own timeout window was just
  shorter than how long ECS needed to fully converge and report stable.

Two separate findings, not one:

1. **The 30-minute RTO target was missed.** Even taking the optimistic
   reading (rollback substantively done by ~23:48–23:58Z), total time from
   deploy start to a confirmed-good service is in the same range as, or
   past, the 30-minute target — not comfortably under it. `pos-service.tf`
   has no `deployment_circuit_breaker` configured, so nothing on the AWS
   side self-detects and reverts a bad rollout; the GitHub Actions
   workflow's own wait is the only thing watching, and it is slow to give up
   (default waiter: ~10 minutes) on an already-slow ECS/ALB convergence.
2. **The workflow's rollback confirmation is a false negative, not a real
   failure.** `aws ecs wait services-stable`'s default polling budget is
   too short for this stack's actual convergence time. The workflow reports
   "rollback failed" via `exit 1` even when the rollback fully succeeded,
   which would train whoever's on call to distrust or double-check a signal
   that is actually reliable in the one way that matters (did the task
   definition change apply) and unreliable in the other (did the wait
   notice in time).

Lesson: this is executed, timed evidence for drill 4 — but timed *over*
budget, so it does not count as a passing drill. Fix candidates worth
weighing before the next attempt: add `deployment_circuit_breaker` with
`rollback = true` on both services (moves the self-heal into AWS instead of
depending on the workflow noticing), and/or increase or replace the
`aws ecs wait services-stable` timeout so a true rollback success is
reported as one.

## 2026-09-21 — Enabling the synthetic probe surfaced one more missing S3 read action

Turning on the external probe (setting `synthetic_probe_url` so
`local.probe_enabled = 1`) tried to create `aws_s3_bucket.synthetics` for
the first time. Apply failed: `AccessDenied: ... not authorized to perform:
s3:GetBucketAcl on resource: "arn:aws:s3:::devops-g2-synthetics-<account>"`.

Same shape as every prior S3 gap in this log: `GroupScopedBuckets` is an
itemized action list (deliberately not `s3:*`, see the comment above it),
and `s3:GetBucketAcl` had simply never come up before because it's the
provider refreshing a bucket attribute this project's four earlier buckets
never happened to exercise in a way that surfaced the gap — the first new
`aws_s3_bucket` resource created since that statement was written was
enough to hit it.

Fixed by adding `s3:GetBucketAcl` to `GroupScopedBuckets`, same
`devops-g2-*` bucket scope as the rest of that statement.

Lesson: identical to the earlier S3 and IAM gaps — an itemized least-
privilege policy is correct, but it means literally *any* new resource of a
kind the role has handled before can still surface a permission nobody
predicted, because the provider's own refresh/read behavior for that
resource type was never exercised end to end until now.

## 2026-09-21 — GetBucketAcl fix retried into GetBucketCORS: fixed the whole family at once

The `GetBucketAcl` fix above hit two things back to back on the next two
apply attempts:

1. The immediate retry (same permission, moments after granting it) failed
   with the identical `AccessDenied` — IAM eventual consistency, same shape
   as the `iam:UpdateAssumeRolePolicy` self-grant earlier tonight. A second
   retry, a few minutes later, got past it cleanly.
2. That successful retry immediately hit a *different* denial:
   `s3:GetBucketCORS`, same `aws_s3_bucket.synthetics` resource, same
   create-then-read pattern.

Rather than fix these one at a time — each cycle costs a PR, a merge, an
apply, and a wait for IAM to catch up — added the rest of the sub-
configuration read actions the provider checks on every `aws_s3_bucket`
create/refresh in one pass: `GetBucketCORS`, `GetBucketWebsite`,
`GetBucketLogging`, `GetBucketObjectLockConfiguration`,
`GetBucketRequestPayment`, `GetReplicationConfiguration`,
`GetAccelerateConfiguration`.

Lesson: when a resource type's permission gaps are surfacing one-by-one
through repeated apply/fail cycles rather than one-by-one through genuinely
new *kinds* of change (the more common shape elsewhere in this log), it's
worth reasoning about the whole family of actions the provider exercises for
that resource type and fixing it in one pass instead of continuing to pay
the apply-and-wait cost per action.

## 2026-09-21 — The synthetic probe could not be a Synthetics canary

**What happened.** `Infra Apply` failed five times in a row, each on a different
error, each one further along than the last. The last two were about the canary:
Lambda rejected `MemorySize: 960` because this account caps it at 512, and the
Terraform provider then rejected `memory_in_mb = 512` because it enforces a 960
floor for canaries.

**Root cause.** Those two constraints cannot both be satisfied. An
`aws_synthetics_canary` is not creatable in this account at any memory value.
Raising the Lambda quota is an AWS support request, not a code change.

**Resolution.** Replaced the canary with an EventBridge-scheduled Lambda that
performs the same checks against the same public entry point and publishes
`SuccessPercent` to `TillFlow/synthetics`. The probe is still external, still
runs every minute, and still alarms with `treat_missing_data = breaching`. What
was given up is the Synthetics console's screenshot and HAR capture, which this
system never needed — its checks are JSON API responses, not rendered pages.

**Lessons.**

- `terraform validate` passing is not evidence that a value is acceptable. It
  accepted `memory_in_mb = 512` happily; the provider's range check only fires
  at plan time. "It validates" was reported as if it meant "it will apply", and
  it cost an apply cycle.
- Two of the five failures (`s3:GetBucketCORS`, then `lambda:GetFunctionConfiguration`
  on `cwsyn-*`) were **IAM propagation lag, not missing permissions** — the
  apply role grants itself a permission and uses it under two seconds later.
  Both were cleared by re-running with the policy already live, after several
  PRs had been merged that added permissions which were already present. The
  durable fix is to move the CI roles into `infra/bootstrap/`, so the role that
  applies a change is never the role the change is granting.
- Changing where a metric comes from silently breaks every dashboard that reads
  it. Repointing the probe's metric required editing both the CloudWatch
  dashboard and the Grafana JSON in the same change; neither would have failed
  a plan, they would just have rendered blank.

## 2026-09-21 — The scheduled-Lambda probe hit one more sixth: events:TagResource

PR #81's own apply (destroying the canary and its bucket, creating the
Lambda, all clean) died on the very last resource:
`aws_cloudwatch_event_rule.probe` — `AccessDenied: ... not authorized to
perform: events:TagResource`.

Same shape as every permission gap tonight, one detail different: this
wasn't a narrow miss on a service already in the policy, it was the first
time this policy had ever needed classic EventBridge (`events:*`) at all.
Commission's schedule uses the newer EventBridge *Scheduler* service
(`scheduler:*`, a separate statement, separate ARN namespace) — nothing
before the probe had exercised `events:*`.

Fixed with a scoped wildcard (`events:*` on `rule/devops-g2-*`), matching
this file's existing pattern for SNS/Lambda/Scheduler — a service this role
manages entirely for itself, resource-scoped to the group prefix, rather
than itemizing one `events:` action at a time the way `GroupScopedBuckets`
and `GroupScopedIAM` do for the two services where a wildcard would actually
be dangerous.

## 2026-09-29 — G5 rebuild: stale `imports.tf` blocks broke every from-scratch plan

The first rebuild `terraform plan` after G5's destroy failed on all four S3
buckets: `infra/main/imports.tf` still held the `import` blocks written for
the 2026-09-20 drift fix (its own comment said "safe to remove once applied
once main"), but nobody had removed them. Those buckets no longer existed
post-destroy, so every plan tried to import resources that were gone.

Fixed by deleting the file.

Lesson: an `import` block is a one-time crutch, and its own comment named
the exact moment it became safe to delete — but nothing enforced that, so it
sat past its shelf life and blocked the next thing that actually needed a
from-scratch apply to work, not just the apply it was written for.

## 2026-09-29 — G5 rebuild: Secrets Manager soft-delete blocked recreation after destroy

The rebuild apply failed creating all three managed secrets
(`service-auth-secret`, `database-url`, `slack-webhook`): "already scheduled
for deletion." `terraform destroy` only soft-deletes Secrets Manager
secrets under AWS's default recovery window, and none of the three secret
resources set `recovery_window_in_days = 0`. Force-purged with
`aws secretsmanager delete-secret --force-delete-without-recovery` to
unblock the rebuild.

**Same failure class already scarred once, 2026-09-20** (S3 bucket drift
blocking Infra Apply) — this is the same "destroy doesn't actually clear
the resource" shape, on a different service. *Not fixed at the source in
this PR* — follow-up: set `recovery_window_in_days = 0` on all three secret
resources so the next teardown doesn't need this manual step again.

Lesson: fixing one resource type's destroy-safety (S3, back in September)
doesn't prove another type is destroy-safe too. A full from-scratch destroy
→ rebuild cycle is the only thing that actually exercises every resource's
teardown path at once, rather than one at a time as each happens to be
touched.

## 2026-09-29 — G5 rebuild: fresh RDS enforced SSL, no `pg.Pool` requested it — masked by liveness-only health checks

Post-rebuild, POS's `/ready` returned 503 with `code: 28000` (Postgres
auth error). Diagnosed via a one-off VPC task testing the secret value
directly: not a password mismatch — `no pg_hba.conf entry for host ... no
encryption`. The fresh RDS instance's default parameter group enforces SSL;
none of the three services' `pg.Pool` construction ever requested it.

**Payments and Web showed "healthy" throughout, which was misleading, not
reassuring.** Their target groups poll `GET /health` — liveness only, no
dependency check — so the identical defect was present in both but silently
masked. Only POS's target group polls `/ready`, which actually touches the
database.

Fixed at the app layer, not by disabling RDS's own SSL enforcement: added
`ssl: { rejectUnauthorized: false }` to every `new Pool(...)` call — all
three services' `server.js`/`run.js` and all three `migrate.js` (six call
sites). **This is a known trade-off, not a finished fix**: it gets an
encrypted connection but does not verify the server certificate, so it is
not protected against a machine-in-the-middle presenting a different cert
within the VPC — encrypted, not authenticated. Follow-up: load the RDS CA
bundle and switch to `ssl: { ca: <bundle>, rejectUnauthorized: true }`.

Lesson: `/health` (liveness) and `/ready` (dependency-checked) polling the
same-looking "healthy" target group tells two different stories, and a
defect that only shows up in one of them will look fine everywhere the
other is what's being watched. It also meant the fastest path to diagnosis
was the service whose health check actually exercised the database, not
the ones that merely looked fine.

## 2026-09-29 — Post-rebuild: the alert-delivery watchdog re-triggered itself for 19 hours

**What happened.** After G5, `devops-g2/slack-webhook` came back empty
(Terraform never versions it, by design — populating it is a manual,
out-of-band step). The watchdog alarm `devops-g2-alert-delivery-failing`
was created at 03:35 EAT (00:35 UTC) 29 Sep and went to `ALARM` one minute
later: its own `OK`→nothing notification failed on the empty secret. From
there it flapped `ALARM` (~19 min) / `OK` (~1 min) on a roughly 20-minute
cycle for exactly 19 hours, until 22:36 EAT (19:36 UTC). Every alert in the
account was silent for that entire window — no Slack message was seen by
anyone, including from the watchdog meant to catch exactly this.

**Root cause.** The watchdog exists to detect a silently-failing notifier,
but its own `ALARM`/`OK` notifications route through that same notifier.
When Slack delivery is genuinely broken, the watchdog's attempt to say so
is broken by the identical mechanism — so instead of surfacing the outage
once, it re-evaluates, fails to notify, and re-triggers itself on every
cycle. A self-triggering loop, not a flaky alarm.

**Resolution.** A new webhook for #devops-group-2 was created and stored
(the previous one was rotated after accidental exposure). Verified via
`set-alarm-state` on `devops-g2-payments-5xx`: `alert_delivered` at
19:35:23 UTC, `RECOVERED` at 19:36:45 UTC; the watchdog itself `RECOVERED`
at 19:36:17 UTC once delivery worked again. Evidence, including the 113-
entry alarm history and the notifier log showing all three deliveries:
[`evidence/reliability-operations/alarms/post-rebuild-slack-test/`](../evidence/reliability-operations/alarms/post-rebuild-slack-test/README.md).

**Follow-ups.** Route `alert-delivery-failing` to a separate non-Slack SNS
topic (email), so it stays visible precisely when Slack itself is down —
that's the one condition under which routing it through Slack can never
work. Also make an empty webhook secret fail loudly at deploy/apply time
instead of silently accepting it and only discovering the gap when an
alarm actually fires.

Lesson: a watchdog that shares a delivery path with the thing it watches
isn't watching it — it's an echo of the same failure. Guarding against a
notifier outage means the guard's own alert has to survive that exact
outage, which by definition means it cannot use the same channel.
