# Artifacts bucket — CI/CD build artifacts
resource "aws_s3_bucket" "artifacts" {
  bucket = "devops-g2-artifacts-${local.account_id}"
  tags   = merge(local.common_tags, { service = "ci-cd" })
}

resource "aws_s3_bucket_versioning" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = "arn:aws:kms:us-east-2:240462142849:key/8c6ce9d0-c78d-4158-a895-7e14d0fb8942"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    id     = "expire-noncurrent"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 14
    }
    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }
  }
}

# Logs bucket — ALB access logs
resource "aws_s3_bucket" "logs" {
  bucket = "devops-g2-logs-${local.account_id}"
  tags   = merge(local.common_tags, { service = "networking" })
}

resource "aws_s3_bucket_versioning" "logs" {
  bucket = aws_s3_bucket.logs.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = "arn:aws:kms:us-east-2:240462142849:key/8c6ce9d0-c78d-4158-a895-7e14d0fb8942"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "logs" {
  bucket                  = aws_s3_bucket.logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id
  rule {
    id     = "expire-old-logs"
    status = "Enabled"
    filter {}
    transition {
      days          = 30
      storage_class = "STANDARD_IA"
    }
    expiration {
      days = 90
    }
  }
}

# Backups bucket — DB/export backups
resource "aws_s3_bucket" "backups" {
  bucket = "devops-g2-backups-${local.account_id}"
  tags   = merge(local.common_tags, { service = "database" })
}

resource "aws_s3_bucket_versioning" "backups" {
  bucket = aws_s3_bucket.backups.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = "arn:aws:kms:us-east-2:240462142849:key/8c6ce9d0-c78d-4158-a895-7e14d0fb8942"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket                  = aws_s3_bucket.backups.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    id     = "expire-backups"
    status = "Enabled"
    filter {}
    transition {
      days          = 7
      storage_class = "STANDARD_IA"
    }
    expiration {
      days = 30
    }
  }
}

# Evidence bucket — capstone evidence pack
resource "aws_s3_bucket" "evidence" {
  bucket = "devops-g2-evidence-${local.account_id}"
  tags   = merge(local.common_tags, { service = "capstone" })
}

resource "aws_s3_bucket_versioning" "evidence" {
  bucket = aws_s3_bucket.evidence.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "evidence" {
  bucket = aws_s3_bucket.evidence.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = "arn:aws:kms:us-east-2:240462142849:key/8c6ce9d0-c78d-4158-a895-7e14d0fb8942"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "evidence" {
  bucket                  = aws_s3_bucket.evidence.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

output "artifacts_bucket_name" {
  value = aws_s3_bucket.artifacts.bucket
}
output "logs_bucket_name" {
  value = aws_s3_bucket.logs.bucket
}
output "backups_bucket_name" {
  value = aws_s3_bucket.backups.bucket
}
output "evidence_bucket_name" {
  value = aws_s3_bucket.evidence.bucket
}
