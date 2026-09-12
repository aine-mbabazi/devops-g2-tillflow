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

_(To be filled in once Terraform is written at G1 — one-command bootstrap,
deploy, and destroy scripts/commands go here.)_

```bash
# bootstrap
# terraform -chdir=infra init

# deploy
# terraform -chdir=infra apply

# destroy
# terraform -chdir=infra destroy
```

## URLs

_(To be filled in once services are deployed — public ALB/API Gateway URL,
Grafana dashboard link, etc.)_

## Demo script

_(To be filled in at G2 — steps to walk through a live sale -> payment ->
commission flow.)_

## Cost

_(To be filled in once infra is provisioned — approximate monthly AWS cost
based on chosen instance sizes and usage.)_

## Cleanup status

_(To be updated before each gate — confirms whether infra is currently
provisioned or torn down, to avoid unnecessary AWS charges.)_

## Documentation index

- [`docs/ownership.md`](docs/ownership.md) — ownership matrix
- [`docs/architecture.md`](docs/architecture.md) — system architecture
- [`docs/payment-contract.md`](docs/payment-contract.md) — proposed POS → Payments contract for G0 review
- [`docs/adr/`](docs/adr/) — architecture decision records
- [`docs/threat-model.md`](docs/threat-model.md) — threat model
- [`docs/slo-error-budgets.md`](docs/slo-error-budgets.md) — SLOs and error budgets
- `docs/runbook.md` — operational runbook (added at G3)
- `docs/scar-log.md` — incident/scar log (added as needed)
