# Threat Model — TillFlow (Group 2)

## Scope

This threat model covers the TillFlow system: Web, POS, Payments, and Commission
services running on ECS Fargate, backed by RDS, Redis, S3, SQS, and the Daraja
sandbox. It excludes physical security and end-user device compromise.

## Assets

- Tenant and attendant data (RDS)
- Sale records and payment/payout state (RDS)
- M-Pesa credentials and Daraja API keys (Secrets Manager)
- Slack webhook URL (Secrets Manager)
- Terraform state (S3 + DynamoDB lock)
- Audit/evidence trail (S3, CloudWatch, X-Ray traces)

## Trust boundaries

- Public internet -> API Gateway (first trust boundary)
- API Gateway -> VPC Link -> ALB -> ECS services (private subnets)
- ECS services -> RDS / Redis / SQS (private, no public access)
- ECS services -> Daraja sandbox (external, over public internet, authenticated)
- CI/CD pipeline -> AWS (via OIDC, no long-lived credentials)

## Threats (STRIDE-style) and mitigations

| # | Threat | Category | Mitigation |
|---|--------|----------|------------|
| 1 | Attacker forges a Daraja callback to fake a successful payment | Spoofing | Validate callback signature/source; treat callbacks as untrusted input; reconcile against Daraja transaction query before crediting a sale |
| 2 | Duplicate/replayed callback causes double-crediting a sale or double-paying commission | Tampering / Repudiation | Idempotency keys on sale creation and payout creation; replay must produce one legal state transition only |
| 3 | Compromised task role reads another tenant's data | Information disclosure | Per-tenant row-level scoping in POS/Payments; least-privilege IAM task roles; service-owned DB schemas |
| 4 | Secrets (Daraja keys, Slack webhook, DB credentials) leaked via Git, Terraform state, or build logs | Information disclosure | Store all secrets in Secrets Manager only; secret scanning in CI; never in `.tf` files or committed state |
| 5 | Commission worker calls Daraja B2C directly, bypassing Payments API's idempotency guarantees | Tampering | Architectural rule: Commission never calls Daraja directly, only through Payments API |
| 6 | Denial of service against Payments API delays legitimate STK/B2C processing | Denial of service | ALB + ECS auto-scaling; SQS + DLQ absorbs bursts; alarms on queue age and error rate |
| 7 | Malicious or buggy release introduces a payment bug (e.g. double-charge) undetected | Tampering | CI gates: unit/integration/contract/replay tests must pass; post-deploy smoke tests; ECS rollback on failed smoke |
| 8 | Attacker gains AWS console access and makes untracked manual changes | Elevation of privilege | All infrastructure changes via Terraform only; console changes earn no evidence credit and are treated as drift to be reconciled |
| 9 | CI/CD pipeline credentials leaked, allowing unauthorized deploys | Elevation of privilege | OIDC-based short-lived credentials for GitHub Actions; no long-lived AWS keys in CI |
| 10 | Terraform state file exposed, revealing infrastructure secrets/topology | Information disclosure | State bucket has versioning, KMS encryption, block-public-access, and a DynamoDB lock table |

## Out of scope for this capstone

- Physical security of AWS data centers (AWS responsibility)
- End-user device / browser compromise
- Social engineering of team members
- DDoS mitigation beyond what ALB/ECS auto-scaling provides by default

## Residual risk

Any risk not fully mitigated above is recorded with an owner and expiry in
`docs/scar-log.md` once dependency/IaC scan findings are triaged during CI setup.
