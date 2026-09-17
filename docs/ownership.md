# Ownership Matrix - TillFlow (Group 2)

| Primary Area | DRI (GitHub handle) | Owns & Decides |
|---|---|---|
| Product + POS + Web | @aine-mbabazi | Tenant model, frontend flow, POS API, sale state, contracts, validation, web API shell |
| Platform + delivery | @aine-mbabazi | Terraform, IAM, ECS, data services, caching, GitHub Actions deploys, scans |
| Payments + integrity + Commission | @cheshari-pearl | Daraja STK/B2C, callbacks, payment/payout state, idempotency, reconciliation, commission ledger and daily close |
| Reliability + operations | @mercykilonzo | SLIs/SLOs, budgets, ADOT/Grafana, k6, alerts, recovery experiments, runbook |
| CI/CD + golden path | @mercykilonzo | GitHub Actions PR checks, scans, SBOM, post-deploy smoke, rollback |

Every member owns at least one primary area and cross-reviews at least one
other. "Everyone owns it" is not accepted - every row above has exactly one
named DRI.

## Cross-review pairing

| Member | Owns | Cross-reviews |
|---|---|---|
| @aine-mbabazi | Product + POS + Web; Platform + delivery | Payments + integrity + Commission; Reliability + operations |
| @cheshari-pearl | Payments + integrity + Commission | Product + POS + Web; CI/CD + golden path |
| @mercykilonzo | Reliability + operations; CI/CD + golden path | Platform + delivery; Payments + integrity + Commission |
