# ADR 0002: Database (RDS) Configuration

## Status
Accepted

## Context
TillFlow needs a relational database for tenant, sale, payment, and commission
state across the POS, Payments, and Commission services. The brief requires a
per-service schema/role model, an explicit backup/retention policy tied to an
RPO, and a documented Multi-AZ vs single-AZ decision. The team is on a tight
student AWS budget, which is the dominant constraint on this decision.

## Decision

- **Engine:** PostgreSQL 16 (RDS)
- **Instance class:** `db.t3.micro` (burstable, 2 vCPU / 1 GiB RAM)
- **Storage:** 20 GB gp3, general purpose SSD
- **Availability:** Single-AZ (no standby replica)
- **Schema model:** one RDS instance, three service-owned schemas
  (`pos`, `payments`, `commission`), each with its own least-privilege
  database role scoped to its own schema only
- **Connection pooling:** PgBouncer sidecar per service task (transaction
  pooling mode), rather than RDS Proxy
- **Backup window:** daily automated snapshot, 03:00-04:00 EAT (low-traffic
  window), 7-day retention

## Rationale

- **`db.t3.micro` + single-AZ** keeps monthly cost low enough to fit a student
  AWS budget/credits allocation for the full ~2-week capstone window. A
  Multi-AZ Standard deployment roughly doubles compute + storage cost for a
  standby replica the team cannot afford to run continuously.
- **PostgreSQL 16** is a stable, well-supported engine version with no
  additional licensing cost, and matches common local dev tooling.
- **Per-service schemas on one instance** (rather than one RDS instance per
  service) keeps cost to a single instance while still enforcing service
  ownership boundaries through schema + role separation, satisfying the
  brief's "service-owned schemas/roles" requirement without paying for three
  separate databases.
- **PgBouncer over RDS Proxy** avoids RDS Proxy's additional hourly charge;
  a sidecar-based pooler is free beyond the ECS task's own compute cost.
- **7-day backup retention** balances a meaningful recovery window against
  S3/snapshot storage cost, which scales with retention length.

## Consequences

- **No automatic failover.** A single-AZ instance means an AZ outage or
  instance failure causes real downtime until AWS recovers the instance or the
  team restores from a snapshot. This is an accepted risk for a capstone
  environment, not a production recommendation.
- **RPO = 24 hours** (worst case), bounded by the daily snapshot window. Any
  data written after the most recent snapshot is lost on instance failure.
  This RPO is written into `docs/slo-error-budgets.md`'s recovery section and
  will be exercised directly in the G4 restore drill.
- **RTO** depends on manual snapshot restore time (typically 10-20 minutes for
  a 20 GB instance) since there is no automatic Multi-AZ failover.
- Burstable `db.t3.micro` CPU credits could be exhausted under sustained load
  during k6 testing; this is a known limitation to watch for during G3
  capacity testing, and may require a temporary instance-class bump during
  that specific testing window if credits run out.
- Moving to Multi-AZ later (e.g. if budget allows, or for a future non-capstone
  iteration) is a config-only change in Terraform, not an architecture change.

## Alternatives considered

| Option | Pros | Cons |
|--------|------|------|
| `db.t3.micro`, single-AZ (chosen) | Lowest cost; fits student budget | No failover; burstable CPU limits under load |
| `db.t3.small`, single-AZ | More headroom for k6 load testing | Roughly double the compute cost of t3.micro |
| `db.t3.micro`, Multi-AZ | Automatic failover; near-zero RTO | Roughly double total cost; unaffordable for full capstone duration |
| One RDS instance per service | Strongest isolation | 3x instance cost; not viable on this budget |
