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
