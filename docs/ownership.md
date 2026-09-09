# Ownership Matrix — TillFlow (Group 2)

| Primary Area              | DRI (GitHub handle) | Owns & Decides                                                                 |
|---------------------------|----------------------|---------------------------------------------------------------------------------|
| Product + POS              | @aine-mbabazi        | Tenant model, frontend flow, POS API, sale state, contracts, validation         |
| Payments + integrity       | @cheshari-pearl       | Daraja STK/B2C, callbacks, payment/payout state, idempotency, reconciliation    |
| Platform + delivery        | @aine-mbabazi         | Terraform, IAM, ECS, data services, caching, GitHub Actions, CodePipeline, scans|
| Reliability + operations   | @cheshari-pearl        | SLIs/SLOs, budgets, ADOT/Grafana, k6, alerts, recovery experiments, runbook     |

Every member owns at least one primary area and cross-reviews at least one other.
"Everyone owns it" is not accepted — every row above has exactly one named DRI.

## Cross-review pairing
| Member | Owns | Cross-reviews |
|--------|------|----------------|
| @aine-mbabazi | Product + POS, Platform + delivery | Payments + integrity, Reliability + operations |
| @cheshari-pearl | Payments + integrity, Reliability + operations | Product + POS, Platform + delivery |
