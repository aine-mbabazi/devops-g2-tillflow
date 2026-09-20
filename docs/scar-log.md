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
