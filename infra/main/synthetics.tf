// One-minute external synthetic probe (brief: "Terraform provisions a
// one-minute external synthetic probe").
//
// The canary is gated on var.synthetic_probe_url rather than wired straight to
// aws_apigatewayv2_stage.default.invoke_url. Two reasons, both practical:
// the API Gateway arrives on a separate branch (PR #46), so a hard reference
// would make `terraform plan` on main fail until that lands; and the probe's
// target is an apply-time fact — if the public entry point ever moves, the
// probe should follow it without an edit to this file.
//
// Turn it on with one line, after the gateway is applied:
//   terraform apply -var "synthetic_probe_url=$(terraform output -raw api_gateway_invoke_url)"
// or by adding it to the workflow's TF_VAR_ environment.

variable "synthetic_probe_url" {
  type        = string
  default     = ""
  description = "Public base URL for the external synthetic probe, e.g. the api_gateway_invoke_url output. Empty leaves the canary unprovisioned."

  validation {
    condition     = var.synthetic_probe_url == "" || startswith(var.synthetic_probe_url, "https://")
    error_message = "synthetic_probe_url must be an https:// URL — the probe is deliberately external, so it must not target the internal ALB over plain HTTP."
  }
}

locals {
  probe_enabled = var.synthetic_probe_url != "" ? 1 : 0

  # Synthetics rejects a trailing slash joined to a path ("//health"), and
  # `terraform output -raw api_gateway_invoke_url` returns one.
  probe_base_url = trimsuffix(var.synthetic_probe_url, "/")
}

data "archive_file" "probe" {
  type        = "zip"
  source_dir  = "${path.module}/canary"
  output_path = "${path.module}/.build/probe.zip"
}

# Canary run artifacts (screenshots, HAR, logs) are written per run. They are
# operational exhaust, not evidence, so they expire on their own rather than
# accumulating in the shared logs bucket where a lifecycle rule for ALB logs
# would have to reason about them too.
resource "aws_s3_bucket" "synthetics" {
  count  = local.probe_enabled
  bucket = "${local.name_prefix}-synthetics-${local.account_id}"
  tags   = merge(local.common_tags, { service = "reliability" })
}

resource "aws_s3_bucket_public_access_block" "synthetics" {
  count                   = local.probe_enabled
  bucket                  = aws_s3_bucket.synthetics[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "synthetics" {
  count  = local.probe_enabled
  bucket = aws_s3_bucket.synthetics[0].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "synthetics" {
  count  = local.probe_enabled
  bucket = aws_s3_bucket.synthetics[0].id
  versioning_configuration {
    status = "Enabled"
  }
}

# A canary at one-minute frequency writes 1,440 runs a day. Seven days is
# enough to investigate an incident from the weekend; beyond that the CloudWatch
# metrics are the record, not the artifacts.
resource "aws_s3_bucket_lifecycle_configuration" "synthetics" {
  count  = local.probe_enabled
  bucket = aws_s3_bucket.synthetics[0].id

  rule {
    id     = "expire-canary-artifacts"
    status = "Enabled"
    filter {}
    expiration {
      days = 7
    }
    noncurrent_version_expiration {
      noncurrent_days = 1
    }
  }
}

resource "aws_iam_role" "probe" {
  count = local.probe_enabled
  name  = "${local.name_prefix}-synthetic-probe"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = merge(local.common_tags, { service = "reliability" })
}

resource "aws_iam_role_policy" "probe" {
  count = local.probe_enabled
  name  = "${local.name_prefix}-synthetic-probe"
  role  = aws_iam_role.probe[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "WriteRunArtifacts"
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:GetBucketLocation"]
        Resource = ["${aws_s3_bucket.synthetics[0].arn}/*", aws_s3_bucket.synthetics[0].arn]
      },
      {
        # Synthetics enumerates buckets to resolve the artifact location. It
        # cannot be scoped to one bucket — s3:ListAllMyBuckets has no resource
        # dimension — so it is granted alone rather than as part of a wider s3:*.
        Sid      = "ResolveArtifactBucket"
        Effect   = "Allow"
        Action   = ["s3:ListAllMyBuckets"]
        Resource = "*"
      },
      {
        Sid      = "WriteOwnLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "arn:aws:logs:${data.aws_region.current.name}:${local.account_id}:log-group:/aws/lambda/cwsyn-${local.name_prefix}-probe-*"
      },
      {
        # Scoped by namespace: the canary publishes its own run metrics and
        # must not be able to write to any other namespace in the account.
        Sid      = "PublishCanaryMetrics"
        Effect   = "Allow"
        Action   = ["cloudwatch:PutMetricData"]
        Resource = "*"
        Condition = {
          StringEquals = { "cloudwatch:namespace" = "CloudWatchSynthetics" }
        }
      },
    ]
  })
}

resource "aws_synthetics_canary" "probe" {
  count = local.probe_enabled

  name                 = "${local.name_prefix}-probe"
  artifact_s3_location = "s3://${aws_s3_bucket.synthetics[0].bucket}/canary/"
  execution_role_arn   = aws_iam_role.probe[0].arn
  handler              = "probe.handler"
  zip_file             = data.archive_file.probe.output_path
  runtime_version      = "syn-nodejs-puppeteer-9.0"
  start_canary         = true

  schedule {
    expression = "rate(1 minute)"
  }

  run_config {
    timeout_in_seconds = 30
    memory_in_mb       = 960
    environment_variables = {
      PROBE_BASE_URL = local.probe_base_url
    }
  }

  # No vpc_config, deliberately. A canary inside the VPC would prove the ALB
  # answers its own subnet, which is not the claim being made — the claim is
  # that a customer on the public internet can reach TillFlow.
  success_retention_period = 7
  failure_retention_period = 14

  tags = merge(local.common_tags, { service = "reliability" })
}

resource "aws_cloudwatch_metric_alarm" "probe_failing" {
  count = local.probe_enabled

  alarm_name          = "${local.name_prefix}-synthetic-probe-failing"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = 100
  period              = 60
  statistic           = "Average"
  namespace           = "CloudWatchSynthetics"
  metric_name         = "SuccessPercent"

  # The one alarm in this stack where missing data IS breaching. No datapoints
  # means the canary itself stopped running, and a probe that is not running is
  # indistinguishable, from the outside, from a system that is down.
  treat_missing_data = "breaching"

  dimensions = { CanaryName = aws_synthetics_canary.probe[0].name }

  # 2-of-3 at one-minute periods: a single failed run is usually a transient
  # DNS or TLS blip from the Synthetics fleet, two inside three minutes is not.
  alarm_description = jsonencode({
    service      = "platform"
    owner        = "@mercykilonzo"
    symptom      = "The external synthetic probe cannot reach TillFlow through its public entry point."
    impact       = "TillFlow is unreachable from the internet. Every SLI is breaching simultaneously. This is the outage alert."
    unit         = "percent of successful runs"
    panel        = ""
    runbook      = "#synthetic-probe-failing"
    first_action = "Check the API Gateway before the services — a VPC Link or integration failure looks exactly like every service being down at once, and the services are usually fine."
  })

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = merge(local.common_tags, { service = "reliability" })
}

output "synthetic_probe_name" {
  description = "Name of the external probe canary, or null when synthetic_probe_url is unset"
  value       = local.probe_enabled == 1 ? aws_synthetics_canary.probe[0].name : null
}
