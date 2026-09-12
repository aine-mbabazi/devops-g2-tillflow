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
- AWS SSO access configured (`aws sso login --sso-session assignment3-session`)
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
```bash
cd infra/main
export AWS_PROFILE=assignment3
terraform init
terraform plan
terraform apply
```

### Deploy application changes (Payments)
Automated via GitHub Actions on every merge to `main` that touches
`services/payments/` — see `.github/workflows/release.yml`. No manual
steps required; the pipeline builds, pushes to ECR, and deploys to ECS
automatically.

Manual deploy (if needed):
```bash
cd services/payments
SHA=$(git rev-parse --short HEAD)
aws ecr get-login-password --region us-east-2 | docker login --username AWS --password-stdin 240462142849.dkr.ecr.us-east-2.amazonaws.com
docker build -t 240462142849.dkr.ecr.us-east-2.amazonaws.com/devops-g2/payments:$SHA .
docker push 240462142849.dkr.ecr.us-east-2.amazonaws.com/devops-g2/payments:$SHA
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
- **ECR repository:** `240462142849.dkr.ecr.us-east-2.amazonaws.com/devops-g2/payments`
- **CloudWatch Logs:** `/devops-g2/payments`
- Grafana dashboard: not yet set up (planned for G3)

## Demo script

_(To be filled in at G2 — steps to walk through a live sale -> payment ->
commission flow.)_

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
- [`docs/adr/`](docs/adr/) — architecture decision records
- [`docs/threat-model.md`](docs/threat-model.md) — threat model
- [`docs/slo-error-budgets.md`](docs/slo-error-budgets.md) — SLOs and error budgets
- `docs/runbook.md` — operational runbook (added at G3)
- `docs/scar-log.md` — incident/scar log (added as needed)
