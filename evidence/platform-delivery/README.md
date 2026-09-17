# Platform + delivery — evidence

Normal DRI: @aine-mbabazi. Cross-reviewed by @cheshari-pearl.

## What's provisioned

Everything below exists in account `240462142849`, region `us-east-2`, and is
managed by `infra/main/`.

### Data layer
- **RDS PostgreSQL 16**, `db.t4g.micro`, single-AZ per ADR 0002, encrypted
  gp3 storage, 7-day automated backups, in the private subnets with a
  dedicated security group that accepts 5432 from the ECS tasks SG only.
  Endpoint: `devops-g2-db.cxwaioocu1ls.us-east-2.rds.amazonaws.com`.
- **Migrations applied** to three schemas: `pos` (sales, tenant_config),
  `payments` (payment_attempts, payout_attempts), `commission`
  (ledger_entries). Run via one-off ECS tasks, not on service boot.

### Secrets
- `devops-g2/service-auth-secret` — HMAC key shared by POS, Payments, Commission.
- `devops-g2/database-url` — full `postgresql://...?sslmode=no-verify` connection
  string. Read by all three execution roles at task start.

### Compute
- **ECS Fargate cluster `devops-g2`** with two long-running services
  (`devops-g2-pos`, `devops-g2-payments`) and one scheduled worker
  (`devops-g2-commission`, EventBridge Scheduler at 02:00 UTC).
- **Three ECR repositories** (`pos`, `payments`, `commission`), immutable tags,
  scan-on-push.
- All task definitions set `*_STORE=postgres` and pull `DATABASE_URL` from
  Secrets Manager.

### Networking
- VPC `10.20.0.0/16`, two public subnets (IGW + NAT), two private subnets
  (NAT egress), single NAT gateway.
- Internal ALB in front of the two ECS services, with path-based listener
  rules (`/sales*` -> POS, default -> Payments).

### Object storage
- Five S3 buckets, one per purpose: `artifacts`, `logs`, `backups`,
  `evidence`, `tillflow-tfstate`. All: versioning, KMS encryption,
  block-public-access. Lifecycle rules on the non-state buckets.

### IAM + CI/CD
- GitHub Actions OIDC — no long-lived credentials. Two roles:
  - `devops-g2-ci-deploy` — plan + release workflows (POS, Payments, Commission).
  - `devops-g2-ci-apply` — gated `production` apply.
- Trust policies scope `job_workflow_ref` to the five workflows that
  legitimately need it; `PassRoleToECS` covers the six task/execution roles.

## Reproduction commands

From the repo root, with `AWS_PROFILE=assignment3`:

```bash
aws rds describe-db-instances --region us-east-2 \
  --query 'DBInstances[?starts_with(DBInstanceIdentifier, `devops-g2`)].{id:DBInstanceIdentifier,status:DBInstanceStatus,endpoint:Endpoint.Address}'

for r in pos payments commission; do
  aws ecr describe-repositories --repository-name devops-g2/$r --region us-east-2 \
    --query 'repositories[0].repositoryUri' --output text
done
```

aws iam get-role --role-name devops-g2-ci-deploy \
  --query 'Role.AssumeRolePolicyDocument.Statement[0].Condition'

for svc in pos payments; do
  aws ecs describe-task-definition --task-definition devops-g2-$svc \
    --query 'taskDefinition.containerDefinitions[0].environment[?contains(name, `STORE`)]'
done

## Live proof (run 2026-09-18)
A one-off ECS task ran POS, curl'd its own /ready and /health, and printed:

```text
{"service":"pos","event":"listening","posStore":"postgres"}
{"service":"pos","status":"ready"}
{"service":"pos","status":"ok"}
```
That is the whole point: the service booted on Fargate, connected to RDS,
and answered its readiness probe — which runs SELECT 1 against the real
database.

## Known gaps (deferred to G3)
API Gateway + VPC Link — the ALB is internal-only, so there is no
public entry point yet. Planned for G3.

ElastiCache (Redis/Valkey) — not provisioned. Services talk to RDS
directly; the cache-aside layer is a G3 item.

SQS + DLQ — not provisioned. Nothing async yet.

One NAT gateway, one AZ RDS — accepted cost trade-off recorded in
ADR 0002, not an oversight.

No alerting — CloudWatch alarms, Slack contract, Grafana are all in
the reliability area, not here.
