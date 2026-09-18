// Alert delivery path: CloudWatch alarm -> SNS -> Lambda -> Slack.
//
// SNS's own Slack integrations (chatbot, email-to-channel) post the raw alarm
// JSON. The brief requires a specific contract — environment, service,
// symptom, user/SLO impact, observed value, panel, runbook, owner, first safe
// action — so a small renderer sits in between. It is the only thing in this
// account that holds the webhook.

# A customer-managed key, not the AWS-managed alias/aws/sns.
#
# This is not a preference. CloudWatch Alarms publish to this topic as the
# service principal cloudwatch.amazonaws.com, and publishing to an encrypted
# topic requires kms:GenerateDataKey* on the key. The AWS-managed key's policy
# cannot be edited, so with alias/aws/sns every alarm would fail to publish —
# silently, because a failed SNS publish from an alarm surfaces nowhere. The
# alerting would look provisioned and deliver nothing.
resource "aws_kms_key" "alerts" {
  description             = "Encrypts the TillFlow alerts topic. Alarm bodies carry service and impact detail."
  enable_key_rotation     = true
  deletion_window_in_days = 7

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Without root access the key becomes unmanageable if every other
        # grant is removed. AWS rejects a key policy that locks itself out.
        Sid       = "AllowAccountAdministration"
        Effect    = "Allow"
        Principal = { AWS = "arn:aws:iam::${local.account_id}:root" }
        Action    = "kms:*"
        Resource  = "*"
      },
      {
        Sid       = "AllowCloudWatchAlarmsToPublish"
        Effect    = "Allow"
        Principal = { Service = "cloudwatch.amazonaws.com" }
        Action    = ["kms:GenerateDataKey*", "kms:Decrypt"]
        Resource  = "*"
        Condition = {
          StringEquals = { "aws:SourceAccount" = local.account_id }
        }
      },
    ]
  })

  tags = merge(local.common_tags, { service = "reliability" })
}

resource "aws_kms_alias" "alerts" {
  name          = "alias/${local.name_prefix}-alerts"
  target_key_id = aws_kms_key.alerts.key_id
}

resource "aws_sns_topic" "alerts" {
  name              = "${local.name_prefix}-alerts"
  kms_master_key_id = aws_kms_key.alerts.id
  tags              = merge(local.common_tags, { service = "reliability" })
}

# CloudWatch publishes alarm state changes to the topic. Scoped to this
# account so another account's alarms cannot inject messages that this
# function would faithfully render into the team's Slack channel.
resource "aws_sns_topic_policy" "alerts" {
  arn = aws_sns_topic.alerts.arn

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "AllowCloudWatchAlarmsToPublish"
      Effect    = "Allow"
      Principal = { Service = "cloudwatch.amazonaws.com" }
      Action    = "SNS:Publish"
      Resource  = aws_sns_topic.alerts.arn
      Condition = {
        StringEquals = { "AWS:SourceAccount" = local.account_id }
      }
    }]
  })
}

# The webhook secret is declared here but deliberately has NO
# aws_secretsmanager_secret_version: writing the value through Terraform would
# put it in plan output and in state, which the brief forbids ("never in Git,
# Terraform state or build logs"). It is populated once, out of band:
#
#   aws secretsmanager put-secret-value \
#     --secret-id devops-g2/slack-webhook \
#     --secret-string 'https://hooks.slack.com/services/...'
#
# Until it holds a value the notifier fails loudly on its first invocation,
# which is the intended behaviour — a silently undelivered alert is worse.
resource "aws_secretsmanager_secret" "slack_webhook" {
  name        = "${local.name_prefix}/slack-webhook"
  description = "Slack incoming webhook for the alerts channel. Value set out of band, never through Terraform."
  tags        = merge(local.common_tags, { service = "reliability" })
}

data "archive_file" "slack_notifier" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/slack-notifier"
  output_path = "${path.module}/.build/slack-notifier.zip"
  # The unit tests live beside the handler so they stay in sync with it, but
  # they have no business in the deployed artifact.
  excludes = ["test.mjs"]
}

resource "aws_iam_role" "slack_notifier" {
  name = "${local.name_prefix}-slack-notifier"

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

resource "aws_iam_role_policy" "slack_notifier" {
  name = "${local.name_prefix}-slack-notifier"
  role = aws_iam_role.slack_notifier.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "WriteOwnLogs"
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.slack_notifier.arn}:*"
      },
      {
        Sid      = "ReadWebhookSecret"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = aws_secretsmanager_secret.slack_webhook.arn
      },
    ]
  })
}

# Created explicitly rather than left to Lambda's implicit creation, so it
# carries a retention period and the required tags. Lambda's own group has no
# expiry by default and would accumulate cost indefinitely.
resource "aws_cloudwatch_log_group" "slack_notifier" {
  name              = "/aws/lambda/${local.name_prefix}-slack-notifier"
  retention_in_days = 14
  tags              = merge(local.common_tags, { service = "reliability" })
}

resource "aws_lambda_function" "slack_notifier" {
  function_name = "${local.name_prefix}-slack-notifier"
  role          = aws_iam_role.slack_notifier.arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  timeout       = 10

  filename         = data.archive_file.slack_notifier.output_path
  source_code_hash = data.archive_file.slack_notifier.output_base64sha256

  # No VPC configuration on purpose. The notifier's whole job is to reach
  # hooks.slack.com; putting it in the private subnets would route it through
  # the NAT gateway and make alert delivery depend on the same networking that
  # an alert may be reporting as broken.
  environment {
    variables = {
      SLACK_WEBHOOK_SECRET_ID = aws_secretsmanager_secret.slack_webhook.name
      ENVIRONMENT             = local.common_tags.environment
      DASHBOARD_BASE_URL      = "https://${data.aws_region.current.name}.console.aws.amazon.com/cloudwatch/home?region=${data.aws_region.current.name}#dashboards/dashboard/${local.name_prefix}-slo"
      RUNBOOK_BASE_URL        = "https://github.com/aine-mbabazi/devops-g2-tillflow/blob/main/docs/runbook.md"
    }
  }

  # The SDK v3 client this function imports ships with the nodejs20.x runtime,
  # so the deployment package is the single source file with no node_modules.
  depends_on = [aws_cloudwatch_log_group.slack_notifier]

  tags = merge(local.common_tags, { service = "reliability" })
}

resource "aws_lambda_permission" "slack_notifier_sns" {
  statement_id  = "AllowExecutionFromSNS"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.slack_notifier.function_name
  principal     = "sns.amazonaws.com"
  source_arn    = aws_sns_topic.alerts.arn
}

resource "aws_sns_topic_subscription" "slack_notifier" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "lambda"
  endpoint  = aws_lambda_function.slack_notifier.arn
}

# Delivery is itself a failure domain: if the notifier throws (empty secret,
# Slack 5xx, expired webhook) nothing else would ever say so. This alarm is
# deliberately routed to the same topic — if the path is broken end to end
# this cannot fire either, which is why the runbook's weekly check is a manual
# synthetic alert rather than trust in this alarm alone.
resource "aws_cloudwatch_metric_alarm" "slack_notifier_errors" {
  alarm_name          = "${local.name_prefix}-alert-delivery-failing"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = 0
  period              = 300
  statistic           = "Sum"
  namespace           = "AWS/Lambda"
  metric_name         = "Errors"
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = aws_lambda_function.slack_notifier.function_name
  }

  alarm_description = jsonencode({
    service      = "reliability"
    owner        = "@mercykilonzo"
    symptom      = "The Slack notifier Lambda is throwing — one or more alerts did not reach the channel."
    impact       = "No user impact directly, but every other alarm in this account is now silent. Treat as a page."
    unit         = "errors / 5 min"
    panel        = ""
    runbook      = "#alert-delivery-failing"
    first_action = "Check the notifier's own log group for alert_delivery_failed, then confirm devops-g2/slack-webhook holds a current webhook URL."
  })

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = merge(local.common_tags, { service = "reliability" })
}

output "alerts_topic_arn" {
  description = "SNS topic every CloudWatch alarm publishes to"
  value       = aws_sns_topic.alerts.arn
}
