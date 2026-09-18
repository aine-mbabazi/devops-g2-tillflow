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

- **ALB (internal only, not internet-facing):**
  `internal-devops-g2-alb-853726153.us-east-2.elb.amazonaws.com`
  — reachable from within the VPC only; not accessible from the public internet.
- **Payments health check:** `http://<alb-dns>/health`
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

_(To be filled in once infra is provisioned — approximate monthly AWS cost
based on chosen instance sizes and usage.)_

## Cleanup status

**Currently provisioned** (as of last update): VPC, ALB, NAT Gateway, ECS
cluster + Payments service, ECR repo, CloudWatch logs, IAM roles, OIDC
CI/CD role. Bootstrap state backend (S3 + DynamoDB) also provisioned.

Update this section before/after each gate to reflect whether infra is
live or torn down, since the NAT Gateway and ALB bill continuously while running.

## Documentation index

- [`docs/ownership.md`](docs/ownership.md) — ownership matrix
- [`docs/architecture.md`](docs/architecture.md) — system architecture
- [`docs/payment-contract.md`](docs/payment-contract.md) — proposed POS → Payments contract for G0 review
- [`docs/commission-payout-contract.md`](docs/commission-payout-contract.md) — proposed Commission → Payments B2C contract for G0 review
- [`docs/adr/`](docs/adr/) — architecture decision records, including [0004 — caching and queueing](docs/adr/0004-caching-and-queueing.md)
- [`docs/threat-model.md`](docs/threat-model.md) — threat model
- [`docs/slo-error-budgets.md`](docs/slo-error-budgets.md) — SLOs and error budgets
- [`docs/runbook.md`](docs/runbook.md) — operational runbook: recovery objectives, rollback vs roll-forward, reconciliation order, restore, per-alarm response, game-day drills
- [`docs/alert-contract.md`](docs/alert-contract.md) — the nine fields every Slack alert carries, and where they are stored
- [`docs/capacity-model.md`](docs/capacity-model.md) — k6 results, bottleneck, headroom and cost assumption
- [`docs/defence-outlines.md`](docs/defence-outlines.md) — 6-minute individual defence outlines, one per DRI
- [`docs/scar-log.md`](docs/scar-log.md) — incident/scar log
