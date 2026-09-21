// One-minute external synthetic probe (brief: "Terraform provisions a
// one-minute external synthetic probe").
//
// Implemented as an EventBridge-scheduled Lambda rather than an
// aws_synthetics_canary, because a canary is impossible in this account:
//
//   Error: expected run_config.0.memory_in_mb to be at least (960), got 512
//   CREATE_FAILED: 'MemorySize' value failed to satisfy constraint:
//                  Member must have value less than or equal to 512
//
// The provider enforces a 960 MB floor for canaries; this account's Lambda
// quota caps MemorySize at 512. Both cannot be satisfied, and raising the quota
// is an AWS support request rather than a code change.
//
// What is preserved is what the brief actually asks for: a probe running every
// minute, OUTSIDE the VPC, over the public internet, through API Gateway. What
// is lost is the Synthetics console's screenshots and HAR capture, which this
// system never needed — its checks are JSON API responses, not rendered pages.
//
// Still gated on var.synthetic_probe_url so `terraform plan` never depends on
// the API Gateway existing. The Infra Apply workflow supplies it from the
// api_gateway_invoke_url output.

variable "synthetic_probe_url" {
  type        = string
  default     = ""
  description = "Public base URL for the external synthetic probe, e.g. the api_gateway_invoke_url output. Empty leaves the probe unprovisioned."

  validation {
    condition     = var.synthetic_probe_url == "" || startswith(var.synthetic_probe_url, "https://")
    error_message = "synthetic_probe_url must be an https:// URL — the probe is deliberately external, so it must not target the internal ALB over plain HTTP."
  }
}

locals {
  probe_enabled = var.synthetic_probe_url != "" ? 1 : 0

  # `terraform output -raw api_gateway_invoke_url` returns a trailing slash,
  # which would make every request path "//health".
  probe_base_url = trimsuffix(var.synthetic_probe_url, "/")
  probe_name     = "${local.name_prefix}-probe"
}

data "archive_file" "probe" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/probe"
  output_path = "${path.module}/.build/probe.zip"
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

resource "aws_cloudwatch_log_group" "probe" {
  count             = local.probe_enabled
  name              = "/aws/lambda/${local.name_prefix}-probe"
  retention_in_days = 14
  tags              = merge(local.common_tags, { service = "reliability" })
}

resource "aws_iam_role_policy" "probe" {
  count = local.probe_enabled
  name  = "${local.name_prefix}-synthetic-probe"
  role  = aws_iam_role.probe[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "WriteOwnLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.probe[0].arn}:*"
      },
      {
        # Scoped by namespace: the probe publishes its own result and must not
        # be able to write to any other namespace in the account.
        Sid      = "PublishProbeMetrics"
        Effect   = "Allow"
        Action   = ["cloudwatch:PutMetricData"]
        Resource = "*"
        Condition = {
          StringEquals = { "cloudwatch:namespace" = "TillFlow/synthetics" }
        }
      },
    ]
  })
}

resource "aws_lambda_function" "probe" {
  count = local.probe_enabled

  function_name = "${local.name_prefix}-probe"
  role          = aws_iam_role.probe[0].arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  timeout       = 30

  # Comfortably inside this account's 512 MB cap. The probe makes two HTTP
  # calls and parses two small JSON bodies; it is not memory-bound.
  memory_size = 256

  filename         = data.archive_file.probe.output_path
  source_code_hash = data.archive_file.probe.output_base64sha256

  # No vpc_config, deliberately. A probe inside the VPC would prove the ALB
  # answers its own subnet, which is not the claim being made — the claim is
  # that a customer on the public internet can reach TillFlow.
  environment {
    variables = {
      PROBE_BASE_URL = local.probe_base_url
      PROBE_NAME     = "${local.name_prefix}-probe"
    }
  }

  depends_on = [aws_cloudwatch_log_group.probe]

  tags = merge(local.common_tags, { service = "reliability" })
}

# EventBridge rather than the Scheduler service: a fixed one-minute rate with no
# flexible window, no retry policy and no IAM pass-role is exactly what a rule
# does, and rate(1 minute) is its minimum granularity — the same floor the
# canary had.
resource "aws_cloudwatch_event_rule" "probe" {
  count               = local.probe_enabled
  name                = "${local.name_prefix}-probe-schedule"
  description         = "Runs the external synthetic probe every minute"
  schedule_expression = "rate(1 minute)"

  tags = merge(local.common_tags, { service = "reliability" })
}

resource "aws_cloudwatch_event_target" "probe" {
  count     = local.probe_enabled
  rule      = aws_cloudwatch_event_rule.probe[0].name
  target_id = "probe"
  arn       = aws_lambda_function.probe[0].arn
}

resource "aws_lambda_permission" "probe_schedule" {
  count         = local.probe_enabled
  statement_id  = "AllowExecutionFromEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.probe[0].function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.probe[0].arn
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
  namespace           = "TillFlow/synthetics"
  metric_name         = "SuccessPercent"

  dimensions = { ProbeName = "${local.name_prefix}-probe" }

  # The one alarm in this stack where missing data IS breaching. No datapoints
  # means the probe itself stopped running, and a probe that is not running is
  # indistinguishable, from the outside, from a system that is down.
  treat_missing_data = "breaching"

  # 2-of-3 at one-minute periods: a single failed run is usually a transient
  # DNS or TLS blip, two inside three minutes is not.
  alarm_description = jsonencode({
    service      = "platform"
    owner        = "@mercykilonzo"
    symptom      = "The external synthetic probe cannot reach TillFlow through its public entry point."
    impact       = "TillFlow is unreachable from the internet. Every SLI is breaching simultaneously. This is the outage alert."
    unit         = "percent of successful checks"
    panel        = ""
    runbook      = "#synthetic-probe-failing"
    first_action = "Check the API Gateway before the services — a VPC Link or integration failure looks exactly like every service being down at once, and the services are usually fine."
  })

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = merge(local.common_tags, { service = "reliability" })
}

output "synthetic_probe_name" {
  description = "Name of the external probe function, or null when synthetic_probe_url is unset"
  value       = local.probe_enabled == 1 ? aws_lambda_function.probe[0].function_name : null
}
