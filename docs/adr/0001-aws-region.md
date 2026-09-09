# ADR 0001: AWS Region Selection

## Status
Accepted

## Context
TillFlow must run in a single AWS region for all Terraform-managed resources
(ECS, RDS, S3, SQS, ElastiCache, EventBridge). The region choice affects latency
to end users, Daraja sandbox reachability, data residency expectations, and cost.

## Decision
We will deploy TillFlow in **us-east-2 (Ohio, USA)**.

## Rationale
- Team familiarity: us-east-2 has been used in prior group projects, which
  reduces setup friction and debugging time under this capstone's tight timeline
- Service availability: ECS Fargate, RDS PostgreSQL, ElastiCache (Redis/Valkey),
  SQS, and EventBridge are all fully available in us-east-2
- Cost: us-east-2 is one of the lower-cost standard AWS regions for on-demand
  Fargate, RDS, and ElastiCache pricing
- Daraja sandbox connectivity does not require regional proximity, since it is
  accessed over the public internet regardless of AWS region

## Consequences
- All `name_prefix = devops-g2` resources will be created in us-east-2 only
- End-user latency from Kenya will be materially higher than a region physically
  closer to East Africa (e.g. eu-west-1 or af-south-1); this is an accepted
  trade-off for this capstone, since the assessment focuses on architecture,
  reliability practices, and evidence rather than production latency for real users
- Multi-region failover is out of scope for this capstone
- Any future compliance requirement (e.g. data residency law) would require
  revisiting this decision

## Alternatives considered
| Region | Pros | Cons |
|--------|------|------|
| us-east-2 (Ohio) | Team already familiar with it; low cost; full service availability | Higher latency to Kenya-based users |
| eu-west-1 (Ireland) | Lower latency to East Africa than US regions | Team has no prior experience here; slightly higher cost on some services |
| af-south-1 (Cape Town) | Lowest latency to East Africa among AWS regions | Fewer services available; typically higher pricing; team has no prior experience here |
