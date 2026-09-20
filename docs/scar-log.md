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
