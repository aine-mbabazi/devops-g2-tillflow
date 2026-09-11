terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "us-east-2"
  profile = "assignment3"
}

data "aws_caller_identity" "current" {}

locals {
  account_id  = data.aws_caller_identity.current.account_id
  name_prefix = "devops-g2"
  common_tags = {
    group       = "g2"
    owner       = "aine-mbabazi"
    environment = "capstone"
    managed-by  = "terraform"
    capstone    = "tillflow"
  }
}

# Shared KMS key for all S3 buckets (per ADR 0003)
resource "aws_kms_key" "s3" {
  description             = "${local.name_prefix} shared S3 encryption key"
  deletion_window_in_days = 7
  tags = merge(local.common_tags, {
    service = "shared"
  })
}

resource "aws_kms_alias" "s3" {
  name          = "alias/${local.name_prefix}-s3-key"
  target_key_id = aws_kms_key.s3.key_id
}

# Terraform state bucket
resource "aws_s3_bucket" "tfstate" {
  bucket = "${local.name_prefix}-tillflow-tfstate-${local.account_id}"
  tags = merge(local.common_tags, {
    service = "terraform-state"
  })
}

resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.s3.arn
    }
  }
}

resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket                  = aws_s3_bucket.tfstate.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# DynamoDB lock table
resource "aws_dynamodb_table" "tflock" {
  name         = "${local.name_prefix}-tflock"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  tags = merge(local.common_tags, {
    service = "terraform-state"
  })
}

output "tfstate_bucket_name" {
  value = aws_s3_bucket.tfstate.bucket
}

output "tflock_table_name" {
  value = aws_dynamodb_table.tflock.name
}

output "kms_key_arn" {
  value = aws_kms_key.s3.arn
}
