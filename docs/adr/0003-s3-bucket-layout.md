# ADR 0003: S3 Bucket Layout

## Status
Accepted

## Context
The brief requires one S3 bucket per purpose (Terraform state, pipeline/build
artifacts, ALB access logs, backups/exports, evidence), each with versioning,
KMS encryption, block-public-access, and a lifecycle/retention policy. The
state bucket additionally requires a DynamoDB lock table. The team is on a
tight student AWS budget, so lifecycle rules favor short retention and moving
older data to cheaper storage classes quickly rather than keeping everything
in Standard indefinitely.

## Decision

Five buckets, one per purpose, named per the brief's convention with an
account-ID suffix for global uniqueness:

| Bucket | Purpose | Versioning | Encryption | Lifecycle |
|--------|---------|------------|------------|-----------|
| `devops-g2-tfstate-<account-id>` | Terraform remote state | Enabled | SSE-KMS | Keep all versions (state history is small; never expire) |
| `devops-g2-artifacts-<account-id>` | Pipeline/build artifacts | Enabled | SSE-KMS | Expire noncurrent versions after 14 days; move current to Infrequent Access after 30 days |
| `devops-g2-logs-<account-id>` | ALB access logs | Enabled | SSE-KMS | Move to Infrequent Access after 30 days; expire after 90 days |
| `devops-g2-backups-<account-id>` | DB/export backups | Enabled | SSE-KMS | Move to Infrequent Access after 7 days; expire after 30 days (matches the 7-day RDS snapshot retention in ADR 0002, plus buffer) |
| `devops-g2-evidence-<account-id>` | Capstone evidence pack | Enabled | SSE-KMS | Keep all versions for the duration of the capstone; no auto-expiry |

All five buckets:
- **Block all public access** enabled at the bucket level
- **SSE-KMS** encryption using a single shared customer-managed KMS key
  (`devops-g2-s3-key`) rather than one key per bucket, to avoid per-key
  monthly charges (~$1/month/key) stacking up across five buckets
- Tagged per the brief's convention: `group`, `owner`, `environment`,
  `service`, `managed-by=terraform`, `capstone=tillflow`

The state bucket is paired with a DynamoDB lock table `devops-g2-tflock`,
on-demand billing mode (no provisioned capacity cost when idle).

## Rationale

- **One shared KMS key instead of five** cuts encryption cost roughly 5x
  (AWS charges per key, not per bucket-using-a-key), while still meeting the
  brief's "KMS encryption" requirement for every bucket.
- **Short lifecycle windows on logs, artifacts, and backups** keep storage
  cost low — these are the buckets that grow continuously during active
  development and testing (every CI run, every ALB request, every backup).
  Standard-to-IA transitions and short expirations prevent silent monthly
  cost creep over the ~2-week capstone.
- **State and evidence buckets keep full history with no expiry** because
  they're small (state files and evidence artifacts are lightweight compared
  to logs/backups) and losing them would be far more costly than the storage
  itself — state loss breaks Terraform's ability to manage infrastructure,
  and evidence loss risks grading.
- **On-demand DynamoDB billing** for the lock table avoids paying for
  provisioned read/write capacity that sits idle outside of `terraform plan`/
  `apply` runs.

## Consequences

- Backups older than 30 days are permanently gone; if a restore is needed
  beyond that window, it isn't possible. This is an accepted trade-off for
  the capstone's short timeline, but is a real production gap that would
  need revisiting outside this context.
- A single shared KMS key means a compromise of that key affects all five
  buckets at once, rather than being isolated per bucket. For this
  capstone's threat model (see `docs/threat-model.md`, threat #4 and #10),
  this is an accepted trade-off given the cost savings; IAM policy still
  restricts which roles can use the key.
- Lifecycle transitions to Infrequent Access have a minimum 30-day storage
  charge and a retrieval fee if accessed early — this is factored into the
  30-day (not shorter) IA transition windows chosen above to avoid triggering
  early-retrieval fees on data that's likely to still be actively referenced.

## Alternatives considered

| Option | Pros | Cons |
|--------|------|------|
| Shared KMS key, short lifecycles (chosen) | Lowest cost; still meets encryption requirement | Single key is a shared blast radius |
| One KMS key per bucket | Stronger key isolation | 5x KMS monthly cost for no meaningful benefit at this scale |
| No lifecycle rules (keep everything in Standard) | Simplest; never lose data | Storage cost grows unbounded over the capstone; not viable on a tight budget |
| Cross-region replication for backups | Stronger durability | Doubles storage cost and adds complexity out of scope for this capstone |
