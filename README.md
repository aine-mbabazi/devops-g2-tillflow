# TillFlow — Group 2

Production-grade multi-tenant SaaS POS with M-Pesa payments (STK Push + B2C) on
AWS ECS Fargate. DevOps Mentorship 2026 final capstone.

## Prerequisites

- AWS account with access to region `us-east-2`
- Terraform >= 1.5
- Docker
- AWS CLI configured with appropriate credentials
- Node.js 20+ and npm for the Payments scaffold (other service runtimes TBD)

## Local development

The [Payments service](services/payments/README.md) has a local scaffold with a
health endpoint and a fake Daraja client. From `services/payments`, run
`npm start` or `npm test`. See its README for configuration and current scope.

## Ownership

See [`docs/ownership.md`](docs/ownership.md) for the full DRI matrix.

| Area | DRI |
|------|-----|
| Product + POS | @aine-mbabazi |
| Payments + integrity | @cheshari-pearl |
| Platform + delivery | @aine-mbabazi |
| Reliability + operations | @cheshari-pearl |

## Architecture

See [`docs/architecture.md`](docs/architecture.md) for the full system design,
and [`docs/adr/0001-aws-region.md`](docs/adr/0001-aws-region.md) for the region
decision.

## Bootstrap / Deploy / Destroy

### Prerequisites
- AWS credentials available to the default credential chain (SSO, env vars,
  `AWS_PROFILE`, or an assumed role). CI uses OIDC — no profile needed.
- Terraform >= 1.5
- Docker
- AWS CLI v2

### One-time bootstrap (state backend — already applied, rarely re-run)
```bash
cd infra/bootstrap
terraform init
terraform apply
```

### Deploy infrastructure changes

Infrastructure is applied by CI, not from a laptop. Opening a PR that touches
`infra/main/` runs `terraform plan`; merging to `main` runs the **Infra Apply**
workflow, which plans, uploads the plan as an artifact, then waits for approval
on the protected `production` environment before applying that exact plan file.

To inspect a plan locally without applying:
```bash
cd infra/main
terraform init
terraform plan
```

#### One-time repository setup for the apply gate
1. Create a `production` environment (Settings → Environments) with at least one
   required reviewer.
2. Set the repository variable `AWS_CI_APPLY_ROLE_ARN` to the
   `devops-g2-ci-apply` role ARN (the `github_actions_apply_role_arn` output).
3. The apply role itself is created by Terraform, so the very first
   `terraform apply` that introduces it must run locally with admin
   credentials. Every apply after that goes through CI.

### Deploy application changes (Payments)
Automated via GitHub Actions on every merge to `main` that touches
`services/payments/` — see `.github/workflows/release.yml`. No manual
steps required; the pipeline builds, pushes to ECR, and deploys to ECS
automatically.

Manual deploy (if needed):
```bash
cd services/payments
SHA=$(git rev-parse --short HEAD)
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGISTRY="${ACCOUNT_ID}.dkr.ecr.us-east-2.amazonaws.com"
aws ecr get-login-password --region us-east-2 | docker login --username AWS --password-stdin "${REGISTRY}"
docker build -t "${REGISTRY}/devops-g2/payments:${SHA}" .
docker push "${REGISTRY}/devops-g2/payments:${SHA}"
```

### Destroy (cost control — NAT Gateway and ALB bill continuously)
```bash
cd infra/main
terraform destroy
```
Note: destroying `infra/main` removes the running Payments service, ALB,
and VPC. The state backend (`infra/bootstrap`) is left in place since it
holds no ongoing cost beyond negligible S3/DynamoDB storage.

## URLs

- **API Gateway (public entry point):** the `api_gateway_invoke_url` Terraform
  output. All external traffic enters here and is forwarded over a VPC Link to
  the internal ALB.
- **ALB (internal only, not internet-facing):**
  `internal-devops-g2-alb-853726153.us-east-2.elb.amazonaws.com`
  — reachable from within the VPC only; not accessible from the public internet.
- **Payments health check:** `<api-gateway-invoke-url>/health`
- **ECR repository:** `<account-id>.dkr.ecr.us-east-2.amazonaws.com/devops-g2/payments`
  (resolve `<account-id>` with `aws sts get-caller-identity --query Account --output text`)
- **CloudWatch Logs:** `/devops-g2/payments`, `/devops-g2/pos`, `/devops-g2/commission`
- **SLO dashboard:** the `slo_dashboard_url` Terraform output (CloudWatch).
  The Grafana equivalent is committed at
  [`observability/grafana/tillflow-slo-dashboard.json`](observability/grafana/tillflow-slo-dashboard.json)
  and imports against a CloudWatch datasource.

## Caching and async

- **Cache-aside** on `GET /tenants/:id/config` via Valkey on ElastiCache. Off
  unless configured (`POS_CACHE=redis` + `CACHE_URL`), and every cache
  operation fails open — a cache outage costs latency, not availability. Note
  the URL must be `rediss://`: transit encryption is on, and `loadConfig`
  rejects a plain scheme at startup rather than letting POS degrade silently to
  Postgres forever.
- **Nothing about money is cached.** Sale and payment state is read from
  Postgres every time.
- **`devops-g2-reconciliation` + its DLQ** resolve payments whose Daraja
  dispatch was unconfirmed. Alarms bound the queue age at 10 minutes and fire on
  any DLQ message at all.
- Rationale, alternatives and consequences:
  [ADR 0004](docs/adr/0004-caching-and-queueing.md).

## Reliability and operations

- **Alerting:** CloudWatch alarm → SNS → a small Lambda renderer → Slack. Every
  alarm carries its alert contract (owner, symptom, user impact, first safe
  action, runbook anchor) in its own `alarm_description`, so an alarm cannot be
  added without one. See [`docs/alert-contract.md`](docs/alert-contract.md).
- **The Slack webhook is not in this repo, in Terraform state, or in build
  logs.** The secret is declared with no version; populate it once, out of band:

  ```bash
  aws secretsmanager put-secret-value --secret-id devops-g2/slack-webhook \
    --secret-string 'https://hooks.slack.com/services/...'
  ```

- **External synthetic probe:** a one-minute CloudWatch Synthetics canary that
  hits the public entry point from outside the VPC. It is gated on
  `synthetic_probe_url` so `terraform plan` does not depend on the API Gateway
  branch having merged. Turn it on with:

  ```bash
  cd infra/main
  terraform apply -var "synthetic_probe_url=$(terraform output -raw api_gateway_invoke_url)"
  ```

- **Load profiles:** [`load/k6/`](load/k6/README.md) — smoke, stepped baseline,
  spike, soak and a capacity ramp. Every profile asserts
  `tillflow_duplicate_dispatch == 0`, so a change that lets a retry dispatch a
  second STK push fails the run regardless of how fast it is. The smoke profile
  also runs on every PR.

## Demo script

See [`docs/demo-script.md`](docs/demo-script.md) for the full walkthrough:
tenant setup, sale (with idempotency replay), pay, reconcile, and commission
claim, with paste-ready commands and expected responses.

## Cost

List prices, `us-east-2`, on-demand. **Estimated from the published rate card,
not a measured bill** — nothing has been applied long enough to produce one.

| Component | Assumption | Est. monthly |
|---|---|---|
| NAT Gateway | 1, always on, before data processing | ~$33 |
| ALB | 1, before LCU charges | ~$16 |
| Synthetics canary | 1/min = 43,200 runs at $0.0012 | ~$52 |
| RDS `db.t4g.micro` | single-AZ + 20 GB gp3 | ~$14 |
| ECS Fargate | 3 continuous tasks at 0.25 vCPU / 0.5 GB (POS, Payments, Web) + Commission's daily scheduled run (~$0, sub-cent) | ~$27 |
| ElastiCache `cache.t4g.micro` | single node, live | ~$12 |
| CloudWatch alarms | 16 at $0.10 | ~$2 |
| Custom metrics | 8 log-derived at $0.30 | ~$2 |
| KMS | 1 customer-managed key | ~$1 |
| Lambda, S3, SQS, DynamoDB, Secrets Manager | at this volume | <$2 |
| | | **~$161** |

**The one-minute synthetic probe is the single largest line item** — more
than the NAT Gateway, more than the database, and more than all three
continuously-running application services combined. The brief specifies one
minute, so it stays; dropping to five minutes would cost ~$10 instead of
~$52, at the price of ~15 minutes' worst-case detection instead of ~3.
[`docs/capacity-model.md`](docs/capacity-model.md) argues that trade in full
rather than leaving it an accident.

As of 2026-09-21, the probe itself is mid-rollout, not yet costing anything:
`synthetic_probe_url` was wired into `infra-apply.yml` (PR #72), which
surfaced one more missing apply-role permission (`s3:GetBucketAcl`, PR #73,
same shape as every other itemized-permission gap in `docs/scar-log.md`).
Once that merges and applies cleanly, the ~$52/month starts accruing — worth
remembering when comparing an actual bill against this estimate later.

The NAT gateway is the other line worth attention: VPC endpoints for ECR and
Secrets Manager would cut its data-processing charges, though not its hourly
rate.

Costs stop when the stack is destroyed — see [Destroy](#destroy-cost-control--nat-gateway-and-alb-bill-continuously).

## Cleanup status

**Currently provisioned, live, as of 2026-09-21** (confirmed against actual
`infra-apply` run logs, not just merged PRs — several docs in this repo had
gone stale claiming otherwise):

- VPC, ALB (internal), NAT Gateway (single), API Gateway + VPC Link as the
  public entry point (`api_gateway_invoke_url` output, live since 2026-09-18).
- RDS PostgreSQL (single-AZ `db.t4g.micro`).
- ElastiCache (Valkey, `cache.t4g.micro`, single node) and the SQS
  reconciliation queue + DLQ — both live, despite earlier evidence docs
  claiming no apply had run for them.
- ECS cluster running Payments, POS, and Web as continuous services, plus
  Commission as a daily EventBridge-scheduled task (deliberately no
  continuous service for Commission — see `commission-task.tf`).
- Four ECR repositories (`pos`, `payments`, `commission`, `web`).
- S3: `artifacts`, `logs`, `backups`, `evidence` (in `infra/main`), plus the
  bootstrap state backend bucket + DynamoDB lock table (`infra/bootstrap`).
- CloudWatch logs, alarms, IAM roles, OIDC CI/CD roles.

**Mid-rollout:** the external synthetic probe (canary + its own S3 bucket)
is wired but not yet applying cleanly — PR #72 set `synthetic_probe_url`,
which surfaced a missing apply-role permission fixed in PR #73
(`s3:GetBucketAcl`). Once both merge and an apply succeeds, the canary
becomes the largest line item in [Cost](#cost) above.

**Not yet exercised:** a full `terraform destroy` + rebuild cycle for the
*current* set of resources. A partial destroy did happen once earlier in the
project (see the `devops-g2/slack-webhook` secret's pending-deletion
incident in `evidence/reliability-operations/README.md`'s "Live alert
delivery" section) — real evidence a destroy cycle occurred, but not a
clean, complete, timed one against today's stack. Two known blockers if
`terraform destroy` is run as-is, before any object/image cleanup:
- None of the four S3 buckets in `infra/main` set `force_destroy = true`,
  so a bucket holding any object (including old versions, since versioning
  is on) will block its own destroy until emptied manually or the buckets
  are given `force_destroy` first.
- ECR repositories have no `force_delete` set either, so a non-empty
  repository blocks the same way.

RDS itself destroys cleanly with no manual snapshot step
(`skip_final_snapshot = true`, `deletion_protection = false` in `rds.tf`).

**Everything above is intentionally still running** for tonight's defence —
do not destroy before that. Update this section immediately after tearing
anything down, since the NAT Gateway, ALB, and (once live) the synthetic
probe all bill continuously while running.

## Documentation index

- [`docs/ownership.md`](docs/ownership.md) — ownership matrix
- [`docs/architecture.md`](docs/architecture.md) — system architecture
- [`docs/payment-contract.md`](docs/payment-contract.md) — proposed POS → Payments contract for G0 review
- [`docs/commission-payout-contract.md`](docs/commission-payout-contract.md) — proposed Commission → Payments B2C contract for G0 review
- [`docs/adr/`](docs/adr/) — architecture decision records, including [0004 — caching and queueing](docs/adr/0004-caching-and-queueing.md) and [0005 — why the CodePipeline lane is not built](docs/adr/0005-no-codepipeline-lane.md)
- [`docs/threat-model.md`](docs/threat-model.md) — threat model
- [`docs/production-readiness.md`](docs/production-readiness.md) — production readiness review: what is solid, what would stop a real launch, and in what order to fix it
- [`docs/slo-error-budgets.md`](docs/slo-error-budgets.md) — SLOs and error budgets
- [`docs/runbook.md`](docs/runbook.md) — operational runbook: recovery objectives, rollback vs roll-forward, reconciliation order, restore, per-alarm response, game-day drills
- [`docs/alert-contract.md`](docs/alert-contract.md) — the nine fields every Slack alert carries, and where they are stored
- [`docs/capacity-model.md`](docs/capacity-model.md) — k6 results, bottleneck, headroom and cost assumption
- [`docs/defence-outlines.md`](docs/defence-outlines.md) — 6-minute individual defence outlines, one per DRI
- [`docs/scar-log.md`](docs/scar-log.md) — incident/scar log
