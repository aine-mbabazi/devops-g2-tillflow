// Reconciliation queue + dead-letter queue.
//
// The problem it solves is the one the product contract names directly: "a
// timeout is not a decline". When Payments dispatches to Daraja and the
// dispatch is unconfirmed, the payment is durably recorded as pending and
// something has to come back later and resolve it against the provider.
// Before this queue, "something" was a person reading logs.
//
// Why a queue and not a cron sweep over pending rows: a sweep re-reads every
// pending payment on every pass, so its cost grows with the backlog exactly
// when the backlog is growing. A per-payment message with a delivery delay
// reconciles each payment once, at a predictable time after it was created.
//
// Why SQS and not EventBridge: this needs a retry budget, a visibility timeout
// and a dead-letter queue — a work queue, not an event bus. EventBridge already
// has a job here (the daily commission schedule) and it is a different job.

resource "aws_sqs_queue" "reconciliation_dlq" {
  name = "${local.name_prefix}-reconciliation-dlq"

  # 14 days, the maximum. A message reaching the DLQ represents a payment whose
  # state could not be resolved — that is a money question, and it must still be
  # answerable after a weekend and a public holiday.
  message_retention_seconds = 1209600

  sqs_managed_sse_enabled = true

  tags = merge(local.common_tags, { service = "payments" })
}

resource "aws_sqs_queue" "reconciliation" {
  name = "${local.name_prefix}-reconciliation"

  # Longer than the consumer's worst-case run (one Daraja query plus a store
  # write). Too short and a slow query means the same payment is reconciled
  # twice concurrently; the reconciler is idempotent, but duplicate provider
  # queries cost rate limit for nothing.
  visibility_timeout_seconds = 60

  message_retention_seconds = 345600 # 4 days
  sqs_managed_sse_enabled   = true

  # Long polling. Short polling on an idle queue is a bill for empty responses.
  receive_wait_time_seconds = 20

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.reconciliation_dlq.arn
    # Five attempts, spread over the visibility timeout, is ~5 minutes of
    # retrying. A payment Daraja still cannot resolve after that is not going to
    # resolve itself, and it belongs in front of a human.
    maxReceiveCount = 5
  })

  tags = merge(local.common_tags, { service = "payments" })
}

# Only the Payments task role may touch either queue. The reconciler is the
# single producer and the single consumer; nothing else in the account has a
# reason to read a message describing a payment.
resource "aws_iam_role_policy" "payments_reconciliation_queue" {
  name = "${local.name_prefix}-payments-reconciliation-queue"
  role = aws_iam_role.payments_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "sqs:SendMessage",
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
        "sqs:GetQueueUrl",
      ]
      Resource = [aws_sqs_queue.reconciliation.arn, aws_sqs_queue.reconciliation_dlq.arn]
    }]
  })
}

# ---------------------------------------------------------------------------
# Alarms
# ---------------------------------------------------------------------------

# The brief asks for a bounded queue age, and this is what bounds it. Age, not
# depth: a deep queue that is draining fast is healthy, a shallow queue that is
# not moving is not.
resource "aws_cloudwatch_metric_alarm" "reconciliation_queue_age" {
  alarm_name          = "${local.name_prefix}-reconciliation-queue-age"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 600 # seconds
  period              = 300
  statistic           = "Maximum"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  treat_missing_data  = "notBreaching"

  dimensions = { QueueName = aws_sqs_queue.reconciliation.name }

  alarm_description = jsonencode({
    service      = "payments"
    owner        = "@cheshari-pearl"
    symptom      = "Reconciliation messages are sitting unprocessed for more than 10 minutes."
    impact       = "Payments whose Daraja dispatch was unconfirmed are not being resolved. Sales stay pending at the till. Feeds directly into the callback-lag SLI."
    unit         = "seconds (oldest message)"
    panel        = ""
    runbook      = "#reconciliation-queue-age"
    first_action = "Check whether the Payments tasks are running at all before touching the queue. A stalled consumer and a slow Daraja look identical from this metric."
  })

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = merge(local.common_tags, { service = "payments" })
}

# Any message at all. A DLQ with one message in it is a payment nobody can
# account for — there is no threshold above zero that is acceptable here.
resource "aws_cloudwatch_metric_alarm" "reconciliation_dlq" {
  alarm_name          = "${local.name_prefix}-reconciliation-dlq-not-empty"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = 0
  period              = 300
  statistic           = "Maximum"
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  treat_missing_data  = "notBreaching"

  dimensions = { QueueName = aws_sqs_queue.reconciliation_dlq.name }

  alarm_description = jsonencode({
    service      = "payments"
    owner        = "@cheshari-pearl"
    symptom      = "A payment could not be reconciled after five attempts and has landed in the dead-letter queue."
    impact       = "At least one payment's true state is unknown to TillFlow. The customer may have been charged for a sale that will never close."
    unit         = "messages in DLQ"
    panel        = ""
    runbook      = "#reconciliation-dlq"
    first_action = "Read the message, then query Daraja for that payment directly. Do NOT redrive the queue until you know why it failed — five more attempts against a permanently failing case just refills the DLQ."
  })

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = merge(local.common_tags, { service = "payments" })
}

output "reconciliation_queue_url" {
  value = aws_sqs_queue.reconciliation.url
}

output "reconciliation_dlq_url" {
  value = aws_sqs_queue.reconciliation_dlq.url
}
