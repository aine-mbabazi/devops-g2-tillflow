// Every alarm in this file routes to aws_sns_topic.alerts and carries its
// Slack alert contract in `alarm_description` as JSON. That is not decoration:
// the notifier renders those fields directly, so an alarm added without an
// owner or a first safe action arrives in Slack saying "not stated" — visible
// pressure to write it properly rather than a silent omission.
//
// Thresholds trace back to docs/slo-error-budgets.md. Where a number here
// disagrees with that document, that document wins and this file is the bug.

locals {
  # Symptom-based, not cause-based. "POS is returning 5xx to attendants" is
  # worth waking someone for; "CPU is at 71%" is not, and appears below only
  # as saturation context with a deliberately loose threshold.
  alb_error_alarms = {
    pos = {
      target_group = aws_lb_target_group.pos.arn_suffix
      owner        = "@aine-mbabazi"
      runbook      = "#pos-5xx"
      symptom      = "POS is returning 5xx to attendants recording sales."
      impact       = "Attendants cannot record sales. Burns the POS 99.9% budget (40m 19s per 28 days) directly."
      first_action = "Check ECS service events for devops-g2-pos, then the /devops-g2/pos log group for readiness_check_failed — a database outage surfaces here first."
    }
    payments = {
      target_group = aws_lb_target_group.payments.arn_suffix
      owner        = "@cheshari-pearl"
      runbook      = "#payments-5xx"
      symptom      = "Payments is returning 5xx to POS and Commission."
      impact       = "STK pushes and B2C payouts are being rejected. A sale can still be recorded but cannot be paid. Burns the Payments 99.5% budget."
      first_action = "Check /devops-g2/payments for provider_dispatch_unconfirmed. Do NOT retry payouts by hand — reconciliation resolves pending state, a manual retry risks a double disbursement."
    }
  }
}

# ---------------------------------------------------------------------------
# Availability — per-service 5xx at the load balancer
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "service_5xx" {
  for_each = local.alb_error_alarms

  alarm_name          = "${local.name_prefix}-${each.key}-5xx"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 5
  period              = 300
  statistic           = "Sum"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"

  # No traffic is not the same as no errors, and at this stage of the project
  # long idle periods are normal. Treating missing data as breaching would
  # page the team every night for a system nobody is using.
  treat_missing_data = "notBreaching"

  dimensions = {
    LoadBalancer = aws_lb.main.arn_suffix
    TargetGroup  = each.value.target_group
  }

  alarm_description = jsonencode({
    service      = each.key
    owner        = each.value.owner
    symptom      = each.value.symptom
    impact       = each.value.impact
    unit         = "5xx responses / 5 min"
    panel        = ""
    runbook      = each.value.runbook
    first_action = each.value.first_action
  })

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = merge(local.common_tags, { service = each.key })
}

# ---------------------------------------------------------------------------
# Latency — against each service's own SLO, not one shared number
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "pos_latency" {
  alarm_name          = "${local.name_prefix}-pos-latency-p95"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 2
  threshold           = 0.4 # seconds — the POS SLO's p95 < 400 ms
  period              = 300
  extended_statistic  = "p95"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = aws_lb.main.arn_suffix
    TargetGroup  = aws_lb_target_group.pos.arn_suffix
  }

  # 2-of-3 rather than 1-of-1: a single slow 5-minute window during a deploy
  # is not a reliability event, and an alert that fires on every rollout is an
  # alert people mute.
  alarm_description = jsonencode({
    service      = "pos"
    owner        = "@mercykilonzo"
    symptom      = "POS p95 latency is above its 400 ms SLO target."
    impact       = "Recording a sale feels slow at the till. Not yet failing, but the latency half of the POS SLI is breached."
    unit         = "seconds (p95)"
    panel        = ""
    runbook      = "#pos-latency-p95"
    first_action = "Compare against the ECS CPU/memory saturation panels — if both are flat, suspect RDS, not POS. Do not scale out before checking DatabaseConnections."
  })

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = merge(local.common_tags, { service = "pos" })
}

# ---------------------------------------------------------------------------
# Error-budget burn — the budget policy in docs/slo-error-budgets.md, enforced
# ---------------------------------------------------------------------------
#
# Burn rate = observed error ratio / the budget's allowed error ratio. At 1x
# the budget lasts exactly the 28-day window; at 14.4x it is gone in under two
# days, which is what "fast burn" means. The two classes differ in urgency,
# not in kind, so they differ in window and threshold rather than in metric.
#
# Simplification worth naming at defence: Google's multi-window scheme pairs
# each long window with a short one to stop an alarm latching after the burn
# stops. Here recovery is handled by the OK transition and the shorter
# evaluation window instead. That is weaker, and it is a deliberate trade
# against the complexity of six more alarms on a two-week project.

resource "aws_cloudwatch_metric_alarm" "pos_budget_fast_burn" {
  alarm_name          = "${local.name_prefix}-pos-budget-fast-burn"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = 0.0144 # 14.4x of the 0.1% budget
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "ratio"
    expression  = "FILL(errors,0) / IF(requests > 0, requests, 1)"
    label       = "POS error ratio (1h)"
    return_data = true
  }

  metric_query {
    id = "errors"
    metric {
      metric_name = "HTTPCode_Target_5XX_Count"
      namespace   = "AWS/ApplicationELB"
      period      = 3600
      stat        = "Sum"
      dimensions = {
        LoadBalancer = aws_lb.main.arn_suffix
        TargetGroup  = aws_lb_target_group.pos.arn_suffix
      }
    }
  }

  metric_query {
    id = "requests"
    metric {
      metric_name = "RequestCount"
      namespace   = "AWS/ApplicationELB"
      period      = 3600
      stat        = "Sum"
      dimensions = {
        LoadBalancer = aws_lb.main.arn_suffix
        TargetGroup  = aws_lb_target_group.pos.arn_suffix
      }
    }
  }

  alarm_description = jsonencode({
    service      = "pos"
    owner        = "@mercykilonzo"
    symptom      = "POS is burning its 28-day error budget 14.4x faster than sustainable."
    impact       = "At this rate the entire 40m 19s budget is gone in under two days. Release freeze applies until root-caused."
    unit         = "error ratio over 1h"
    panel        = ""
    runbook      = "#budget-fast-burn"
    first_action = "Freeze releases (stop the release workflow), then triage the POS 5xx alert that almost certainly fired alongside this one."
  })

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = merge(local.common_tags, { service = "pos" })
}

resource "aws_cloudwatch_metric_alarm" "pos_budget_slow_burn" {
  alarm_name          = "${local.name_prefix}-pos-budget-slow-burn"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = 0.006 # 6x of the 0.1% budget
  treat_missing_data  = "notBreaching"

  metric_query {
    id          = "ratio"
    expression  = "FILL(errors,0) / IF(requests > 0, requests, 1)"
    label       = "POS error ratio (6h)"
    return_data = true
  }

  metric_query {
    id = "errors"
    metric {
      metric_name = "HTTPCode_Target_5XX_Count"
      namespace   = "AWS/ApplicationELB"
      period      = 21600
      stat        = "Sum"
      dimensions = {
        LoadBalancer = aws_lb.main.arn_suffix
        TargetGroup  = aws_lb_target_group.pos.arn_suffix
      }
    }
  }

  metric_query {
    id = "requests"
    metric {
      metric_name = "RequestCount"
      namespace   = "AWS/ApplicationELB"
      period      = 21600
      stat        = "Sum"
      dimensions = {
        LoadBalancer = aws_lb.main.arn_suffix
        TargetGroup  = aws_lb_target_group.pos.arn_suffix
      }
    }
  }

  alarm_description = jsonencode({
    service      = "pos"
    owner        = "@mercykilonzo"
    symptom      = "POS is burning its 28-day error budget 6x faster than sustainable."
    impact       = "Budget trending toward exhaustion over days. No freeze yet — raise in standup and prioritise the underlying fix."
    unit         = "error ratio over 6h"
    panel        = ""
    runbook      = "#budget-slow-burn"
    first_action = "Do not page. Open a ticket, attach the burn panel, and put the fix at the top of the next standup."
  })

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = merge(local.common_tags, { service = "pos" })
}

# ---------------------------------------------------------------------------
# Money-correctness — log-derived, not inferable from HTTP status codes
# ---------------------------------------------------------------------------
#
# A duplicated or conflicting callback returns 200 to Daraja by design. None of
# the metrics above would move. These filters turn the services' own structured
# log events into metrics so the invariants can be alarmed on at all.

resource "aws_cloudwatch_log_metric_filter" "callback_conflict" {
  name           = "${local.name_prefix}-callback-conflict"
  log_group_name = aws_cloudwatch_log_group.payments.name
  pattern        = "{ $.event = \"callback_conflict\" }"

  metric_transformation {
    name      = "CallbackConflicts"
    namespace = "TillFlow/integrity"
    value     = "1"
    unit      = "Count"
    # Without an explicit zero, the metric simply has no datapoints when
    # nothing is wrong, and an alarm over it sits in INSUFFICIENT_DATA forever.
    default_value = 0
  }
}

resource "aws_cloudwatch_log_metric_filter" "reconcile_mismatch" {
  name           = "${local.name_prefix}-reconcile-mismatch"
  log_group_name = aws_cloudwatch_log_group.pos.name
  pattern        = "{ $.event = \"reconcile_mismatch\" }"

  metric_transformation {
    name          = "ReconcileMismatches"
    namespace     = "TillFlow/integrity"
    value         = "1"
    unit          = "Count"
    default_value = 0
  }
}

resource "aws_cloudwatch_log_metric_filter" "daily_close_failed" {
  name           = "${local.name_prefix}-daily-close-failed"
  log_group_name = aws_cloudwatch_log_group.commission.name
  pattern        = "{ $.event = \"daily_close_failed\" }"

  metric_transformation {
    name          = "DailyCloseFailures"
    namespace     = "TillFlow/commission"
    value         = "1"
    unit          = "Count"
    default_value = 0
  }
}

# The Payments SLI is "callbacks processed within 60s". services/payments emits
# callback_lag_ms on every terminal callback transition; this extracts it as a
# real metric so the SLI is measured rather than asserted.
resource "aws_cloudwatch_log_metric_filter" "callback_lag" {
  name           = "${local.name_prefix}-callback-lag"
  log_group_name = aws_cloudwatch_log_group.payments.name
  pattern        = "{ $.event = \"callback_processed\" }"

  metric_transformation {
    name      = "CallbackLagMs"
    namespace = "TillFlow/payments"
    value     = "$.callbackLagMs"
    unit      = "Milliseconds"
  }
}

resource "aws_cloudwatch_metric_alarm" "payments_callback_lag" {
  alarm_name          = "${local.name_prefix}-payments-callback-lag"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 60000 # ms — the Payments SLI's 60-second commitment
  period              = 300
  extended_statistic  = "p95"
  namespace           = "TillFlow/payments"
  metric_name         = "CallbackLagMs"

  # No default_value on this filter, so quiet periods genuinely have no
  # datapoints. Missing data here means "no callbacks arrived", which is not
  # the same as "callbacks are fast" — but it is also not a breach, and the
  # synthetic probe is what notices a fully silent system.
  treat_missing_data = "notBreaching"

  alarm_description = jsonencode({
    service      = "payments"
    owner        = "@cheshari-pearl"
    symptom      = "Daraja callbacks are taking more than 60s to reach a terminal state (p95)."
    impact       = "Sales stay pending at the till after the customer has paid. This is the Payments SLI breaching, and it is what customers complain about first."
    unit         = "milliseconds (p95)"
    panel        = ""
    runbook      = "#payments-callback-lag"
    first_action = "Run the reconciliation path rather than retrying payments. A slow callback is not a failed payment — a retry is how a double charge happens."
  })

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = merge(local.common_tags, { service = "payments" })
}

resource "aws_cloudwatch_metric_alarm" "callback_conflict" {
  alarm_name          = "${local.name_prefix}-payments-callback-conflict"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = 0
  period              = 300
  statistic           = "Sum"
  namespace           = "TillFlow/integrity"
  metric_name         = "CallbackConflicts"
  treat_missing_data  = "notBreaching"

  alarm_description = jsonencode({
    service      = "payments"
    owner        = "@cheshari-pearl"
    symptom      = "A Daraja callback reported an outcome that contradicts the stored terminal state."
    impact       = "Possible money-state divergence between TillFlow and Daraja. Zero tolerance — any occurrence is investigated."
    unit         = "conflicts / 5 min"
    panel        = ""
    runbook      = "#payments-callback-conflict"
    first_action = "Do not mutate payment state. Pull the paymentId from the log event and compare against Daraja's transaction query before touching anything."
  })

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = merge(local.common_tags, { service = "payments" })
}

resource "aws_cloudwatch_metric_alarm" "reconcile_mismatch" {
  alarm_name          = "${local.name_prefix}-pos-reconcile-mismatch"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = 0
  period              = 300
  statistic           = "Sum"
  namespace           = "TillFlow/integrity"
  metric_name         = "ReconcileMismatches"
  treat_missing_data  = "notBreaching"

  alarm_description = jsonencode({
    service      = "pos"
    owner        = "@aine-mbabazi"
    symptom      = "Payments reported a succeeded payment whose tenant, sale, amount or currency does not match POS's own sale record."
    impact       = "A sale was NOT marked paid, deliberately. The customer may have been charged for a sale TillFlow will not close. Zero tolerance."
    unit         = "mismatches / 5 min"
    panel        = ""
    runbook      = "#pos-reconcile-mismatch"
    first_action = "Read the reconcile_mismatch log event — it carries both records. Establish which side is wrong before changing either."
  })

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = merge(local.common_tags, { service = "pos" })
}

resource "aws_cloudwatch_metric_alarm" "daily_close_failed" {
  alarm_name          = "${local.name_prefix}-commission-close-failed"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  threshold           = 0
  period              = 3600
  statistic           = "Sum"
  namespace           = "TillFlow/commission"
  metric_name         = "DailyCloseFailures"
  treat_missing_data  = "notBreaching"

  alarm_description = jsonencode({
    service      = "commission"
    owner        = "@cheshari-pearl"
    symptom      = "The Commission daily close exited with an error."
    impact       = "Attendants do not get paid their commission today. The SLO's 06:30 EAT terminal deadline is at risk — there is roughly 90 minutes of slack after the 05:00 EAT run."
    unit         = "failed runs / hour"
    panel        = ""
    runbook      = "#commission-close-failed"
    first_action = "Re-run the scheduled task. The run ID is derived from the UTC date, so a re-run reuses the same idempotency keys and cannot double-pay."
  })

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = merge(local.common_tags, { service = "commission" })
}

# ---------------------------------------------------------------------------
# Saturation and dependencies — context for the symptom alarms above
# ---------------------------------------------------------------------------
#
# These are deliberately loose. They exist so that when a symptom alarm fires
# the responder can tell cause from coincidence, not so that they page anyone
# on their own.

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${local.name_prefix}-rds-cpu-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 80
  period              = 300
  statistic           = "Average"
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  treat_missing_data  = "notBreaching"

  dimensions = { DBInstanceIdentifier = aws_db_instance.main.identifier }

  alarm_description = jsonencode({
    service      = "data"
    owner        = "@aine-mbabazi"
    symptom      = "RDS CPU has been above 80% for 15 minutes."
    impact       = "No direct user impact yet. Every service shares this single db.t4g.micro instance, so this is the most likely next cause of a latency breach."
    unit         = "percent"
    panel        = ""
    runbook      = "#rds-saturation"
    first_action = "Check Performance Insights for the dominant query before resizing. The instance is single-AZ, so a resize is a restart and a brief outage."
  })

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = merge(local.common_tags, { service = "data" })
}

resource "aws_cloudwatch_metric_alarm" "rds_storage" {
  alarm_name          = "${local.name_prefix}-rds-storage-low"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  threshold           = 4294967296 # 4 GiB of the allocated 20 GiB
  period              = 300
  statistic           = "Minimum"
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  treat_missing_data  = "notBreaching"

  dimensions = { DBInstanceIdentifier = aws_db_instance.main.identifier }

  alarm_description = jsonencode({
    service      = "data"
    owner        = "@aine-mbabazi"
    symptom      = "RDS free storage is below 4 GiB."
    impact       = "Storage autoscaling is disabled on this instance (max_allocated_storage = 0). At zero, every write fails — POS, Payments and Commission all stop at once."
    unit         = "bytes free"
    panel        = ""
    runbook      = "#rds-storage-low"
    first_action = "Raise allocated_storage in infra/main/rds.tf and apply. Do not delete rows to buy space — the payment ledger is the audit trail."
  })

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = merge(local.common_tags, { service = "data" })
}

resource "aws_cloudwatch_metric_alarm" "unhealthy_targets" {
  for_each = local.alb_error_alarms

  alarm_name          = "${local.name_prefix}-${each.key}-unhealthy-targets"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  datapoints_to_alarm = 2
  threshold           = 0
  period              = 60
  statistic           = "Maximum"
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = aws_lb.main.arn_suffix
    TargetGroup  = each.value.target_group
  }

  alarm_description = jsonencode({
    service = each.key
    owner   = each.value.owner
    symptom = "${each.key} has a target failing its load balancer health check."
    # desired_count is 1 for both services, so "one unhealthy target" and
    # "the service is down" are currently the same sentence. Worth saying
    # plainly in the alert rather than leaving the responder to work it out.
    impact       = "At desired_count = 1 there is no healthy peer. One unhealthy target means ${each.key} is down, not degraded."
    unit         = "unhealthy targets"
    panel        = ""
    runbook      = "#unhealthy-targets"
    first_action = "Read the ECS service events first — a task that cannot pull its image and a task that is crash-looping look identical from the load balancer."
  })

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]

  tags = merge(local.common_tags, { service = each.key })
}
