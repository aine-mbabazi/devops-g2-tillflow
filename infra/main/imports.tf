# One-off state reconciliation: these four buckets already exist in the
# account (created before this file's resources were wired into the OIDC
# apply pipeline) but were never tracked in this stack's state, so every
# apply since has failed with BucketAlreadyOwnedByYou. Import blocks bring
# them under management without a manual `terraform import` run outside CI.
#
# Safe to remove once this has been applied once to main — Terraform treats
# an import block as a no-op when the resource is already in state.

import {
  to = aws_s3_bucket.artifacts
  id = "devops-g2-artifacts-${local.account_id}"
}

import {
  to = aws_s3_bucket.logs
  id = "devops-g2-logs-${local.account_id}"
}

import {
  to = aws_s3_bucket.backups
  id = "devops-g2-backups-${local.account_id}"
}

import {
  to = aws_s3_bucket.evidence
  id = "devops-g2-evidence-${local.account_id}"
}
