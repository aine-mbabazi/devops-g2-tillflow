# Ownership Matrix — TillFlow (Group 2)

| Primary Area              | DRI (GitHub handle) | Owns & Decides                                                                 |
|---------------------------|----------------------|---------------------------------------------------------------------------------|
| Product + POS              | @<handle>            | Tenant model, frontend flow, POS API, sale state, contracts, validation         |
| Payments + integrity       | @<handle>            | Daraja STK/B2C, callbacks, payment/payout state, idempotency, reconciliation    |
| Platform + delivery        | @<handle>            | Terraform, IAM, ECS, data services, caching, GitHub Actions, CodePipeline, scans|
| Reliability + operations   | @<handle>            | SLIs/SLOs, budgets, ADOT/Grafana, k6, alerts, recovery experiments, runbook     |

Every member owns at least one primary area and cross-reviews at least one other.
"Everyone owns it" is not accepted — every row above must have exactly one named DRI before G0.

## Cross-review pairing
| Member | Owns | Cross-reviews |
|--------|------|----------------|
| @<handle> | <area> | <area> |
