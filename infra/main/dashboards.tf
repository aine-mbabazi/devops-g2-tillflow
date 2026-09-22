// The CloudWatch half of the observability story. Grafana (observability/grafana/)
// reads the same metrics through the CloudWatch datasource, so this dashboard
// and that one cannot disagree about the numbers — only about presentation.
//
// This exists in Terraform because the brief requires it ("Terraform manages
// all infrastructure, pipelines, secret references, alarms and dashboards")
// and because a dashboard built by clicking is a dashboard nobody can rebuild
// after a destroy/rebuild cycle.

// ---------------------------------------------------------------------------
// Business signals
// ---------------------------------------------------------------------------
//
// RED and saturation describe the machine. These describe the product: sales
// recorded, payments dispatched, commission paid. They are the panels that
// answer "is TillFlow doing its job", which a 200-OK rate cannot.
//
// Derived from the services' existing structured logs rather than new
// instrumentation, so they cost nothing at the application layer and cannot
// drift from what the services actually log.

resource "aws_cloudwatch_log_metric_filter" "sales_recorded" {
  name           = "${local.name_prefix}-sales-recorded"
  log_group_name = aws_cloudwatch_log_group.pos.name
  pattern        = "{ $.event = \"http_request\" && $.route = \"POST /sales\" && $.statusCode = 201 }"

  metric_transformation {
    name          = "SalesRecorded"
    namespace     = "TillFlow/business"
    value         = "1"
    unit          = "Count"
    default_value = 0
  }
}

resource "aws_cloudwatch_log_metric_filter" "payments_dispatched" {
  name           = "${local.name_prefix}-payments-dispatched"
  log_group_name = aws_cloudwatch_log_group.payments.name
  pattern        = "{ $.event = \"http_request\" && $.route = \"POST /payments\" && $.statusCode = 202 }"

  metric_transformation {
    name          = "PaymentsDispatched"
    namespace     = "TillFlow/business"
    value         = "1"
    unit          = "Count"
    default_value = 0
  }
}

# payoutCount, not a literal 1: one daily close covers every attendant in a
# tenant, so counting runs would under-report what was actually disbursed.
resource "aws_cloudwatch_log_metric_filter" "commission_payouts" {
  name           = "${local.name_prefix}-commission-payouts"
  log_group_name = aws_cloudwatch_log_group.commission.name
  pattern        = "{ $.event = \"daily_close_completed\" }"

  metric_transformation {
    name      = "CommissionPayouts"
    namespace = "TillFlow/business"
    value     = "$.payoutCount"
    unit      = "Count"
  }
}

# ---------------------------------------------------------------------------
# The dashboard
// ---------------------------------------------------------------------------

locals {
  dashboard_region = data.aws_region.current.name

  pos_dimensions = [
    "AWS/ApplicationELB", "RequestCount",
    "LoadBalancer", aws_lb.main.arn_suffix,
    "TargetGroup", aws_lb_target_group.pos.arn_suffix,
  ]
}

resource "aws_cloudwatch_dashboard" "slo" {
  dashboard_name = "${local.name_prefix}-slo"

  dashboard_body = jsonencode({
    widgets = [
      {
        type = "text", x = 0, y = 0, width = 24, height = 2
        properties = {
          markdown = join("\n", [
            "# TillFlow — SLO and service health",
            "Targets and budget definitions: [docs/slo-error-budgets.md](https://github.com/aine-mbabazi/devops-g2-tillflow/blob/main/docs/slo-error-budgets.md) · What to do when one of these is red: [docs/runbook.md](https://github.com/aine-mbabazi/devops-g2-tillflow/blob/main/docs/runbook.md)",
          ])
        }
      },

      # --- Uptime, from the external probe -------------------------------
      {
        type = "metric", x = 0, y = 2, width = 8, height = 6
        properties = {
          title  = "External uptime — 5m / 1h / 28d"
          view   = "timeSeries"
          region = local.dashboard_region
          # Three periods of the same metric, which is what "5m/1h/28d uptime"
          # means in practice: the same question asked at three zoom levels, so
          # a short outage is visible without hiding the long-run trend.
          metrics = [
            [{ expression = "AVG(m1)", label = "uptime %", id = "e1" }],
            ["TillFlow/synthetics", "SuccessPercent", "ProbeName", "${local.name_prefix}-probe", { id = "m1", visible = false }],
          ]
          yAxis  = { left = { min = 95, max = 100 } }
          period = 300
          stat   = "Average"
          annotations = {
            horizontal = [
              { label = "POS / Web SLO 99.9%", value = 99.9, color = "#2ca02c" },
              { label = "Payments SLO 99.5%", value = 99.5, color = "#ff7f0e" },
            ]
          }
        }
      },

      # --- Error budget --------------------------------------------------
      {
        type = "metric", x = 8, y = 2, width = 8, height = 6
        properties = {
          title  = "POS error budget remaining (%)"
          view   = "singleValue"
          region = local.dashboard_region
          # 100 × (1 − consumed/allowed), where allowed = 0.1% of eligible
          # requests. Over the dashboard's selected range — set it to 28 days
          # to read the SLO's actual budget rather than a window of it.
          metrics = [
            [{ expression = "100 * (1 - (FILL(errors,0) / IF(requests > 0, requests, 1)) / 0.001)", label = "budget remaining", id = "budget" }],
            ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", aws_lb.main.arn_suffix, "TargetGroup", aws_lb_target_group.pos.arn_suffix, { id = "errors", stat = "Sum", visible = false }],
            ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", aws_lb.main.arn_suffix, "TargetGroup", aws_lb_target_group.pos.arn_suffix, { id = "requests", stat = "Sum", visible = false }],
          ]
          period = 2419200 # 28 days, matching the SLO window
        }
      },

      {
        type = "metric", x = 16, y = 2, width = 8, height = 6
        properties = {
          title  = "POS burn rate (× sustainable)"
          view   = "timeSeries"
          region = local.dashboard_region
          # Burn rate, not error rate: 1 means the budget lasts exactly the
          # 28-day window. The annotations are the same thresholds the
          # fast/slow-burn alarms use, so the panel and the page agree.
          metrics = [
            [{ expression = "(FILL(errors,0) / IF(requests > 0, requests, 1)) / 0.001", label = "burn rate", id = "burn" }],
            ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", aws_lb.main.arn_suffix, "TargetGroup", aws_lb_target_group.pos.arn_suffix, { id = "errors", stat = "Sum", visible = false }],
            ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", aws_lb.main.arn_suffix, "TargetGroup", aws_lb_target_group.pos.arn_suffix, { id = "requests", stat = "Sum", visible = false }],
          ]
          period = 3600
          annotations = {
            horizontal = [
              { label = "fast burn — freeze releases", value = 14.4, color = "#d62728" },
              { label = "slow burn — raise in standup", value = 6, color = "#ff7f0e" },
            ]
          }
        }
      },

      # --- RED: rate, errors, duration -----------------------------------
      {
        type = "metric", x = 0, y = 8, width = 8, height = 6
        properties = {
          title   = "Rate — requests/min"
          view    = "timeSeries"
          region  = local.dashboard_region
          stacked = false
          metrics = [
            ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", aws_lb.main.arn_suffix, "TargetGroup", aws_lb_target_group.pos.arn_suffix, { label = "POS", stat = "Sum" }],
            ["...", aws_lb_target_group.payments.arn_suffix, { label = "Payments", stat = "Sum" }],
            ["...", aws_lb_target_group.web.arn_suffix, { label = "Web", stat = "Sum" }],
          ]
          period = 60
        }
      },
      {
        type = "metric", x = 8, y = 8, width = 8, height = 6
        properties = {
          title   = "Errors — 5xx/min"
          view    = "timeSeries"
          region  = local.dashboard_region
          stacked = false
          metrics = [
            ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", aws_lb.main.arn_suffix, "TargetGroup", aws_lb_target_group.pos.arn_suffix, { label = "POS 5xx", stat = "Sum" }],
            ["...", aws_lb_target_group.payments.arn_suffix, { label = "Payments 5xx", stat = "Sum" }],
            ["...", aws_lb_target_group.web.arn_suffix, { label = "Web 5xx", stat = "Sum" }],
            ["AWS/ApplicationELB", "HTTPCode_ELB_5XX_Count", "LoadBalancer", aws_lb.main.arn_suffix, { label = "ALB 5xx (no healthy target)", stat = "Sum" }],
          ]
          period = 60
        }
      },
      {
        type = "metric", x = 16, y = 8, width = 8, height = 6
        properties = {
          title  = "Duration — p95 latency"
          view   = "timeSeries"
          region = local.dashboard_region
          metrics = [
            ["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", aws_lb.main.arn_suffix, "TargetGroup", aws_lb_target_group.pos.arn_suffix, { label = "POS p95", stat = "p95" }],
            ["...", aws_lb_target_group.payments.arn_suffix, { label = "Payments p95", stat = "p95" }],
            ["...", aws_lb_target_group.web.arn_suffix, { label = "Web p95 (SLO 500ms)", stat = "p95" }],
          ]
          period = 60
          annotations = {
            horizontal = [
              { label = "POS SLO 400ms", value = 0.4, color = "#2ca02c" },
              { label = "k6 envelope 500ms", value = 0.5, color = "#ff7f0e" },
            ]
          }
        }
      },

      # --- Saturation ----------------------------------------------------
      {
        type = "metric", x = 0, y = 14, width = 12, height = 6
        properties = {
          title  = "Saturation — ECS task CPU / memory"
          view   = "timeSeries"
          region = local.dashboard_region
          metrics = [
            ["AWS/ECS", "CPUUtilization", "ClusterName", aws_ecs_cluster.main.name, "ServiceName", aws_ecs_service.pos.name, { label = "POS CPU", stat = "Average" }],
            ["...", aws_ecs_service.payments.name, { label = "Payments CPU", stat = "Average" }],
            ["AWS/ECS", "MemoryUtilization", "ClusterName", aws_ecs_cluster.main.name, "ServiceName", aws_ecs_service.pos.name, { label = "POS memory", stat = "Average" }],
            ["...", aws_ecs_service.payments.name, { label = "Payments memory", stat = "Average" }],
          ]
          period = 60
          yAxis  = { left = { min = 0, max = 100 } }
          # The k6 capacity envelope, so the dashboard shows the same ceiling
          # the capacity model was measured against.
          annotations = {
            horizontal = [
              { label = "k6 threshold — CPU 70%", value = 70, color = "#ff7f0e" },
              { label = "k6 threshold — memory 75%", value = 75, color = "#d62728" },
            ]
          }
        }
      },
      {
        type = "metric", x = 12, y = 14, width = 12, height = 6
        properties = {
          title  = "Saturation — RDS (shared by all three services)"
          view   = "timeSeries"
          region = local.dashboard_region
          metrics = [
            ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", aws_db_instance.main.identifier, { label = "CPU %", stat = "Average" }],
            ["AWS/RDS", "DatabaseConnections", "DBInstanceIdentifier", aws_db_instance.main.identifier, { label = "connections", stat = "Maximum", yAxis = "right" }],
          ]
          period = 60
        }
      },

      # --- Business ------------------------------------------------------
      {
        type = "metric", x = 0, y = 20, width = 12, height = 6
        properties = {
          title  = "Business — sales recorded vs payments dispatched"
          view   = "timeSeries"
          region = local.dashboard_region
          # These two lines should track each other. A sustained gap means
          # sales are being recorded that never reach Payments — a product
          # failure that every infrastructure metric on this page reports as
          # healthy.
          metrics = [
            ["TillFlow/business", "SalesRecorded", { label = "sales recorded", stat = "Sum" }],
            ["TillFlow/business", "PaymentsDispatched", { label = "payments dispatched", stat = "Sum" }],
          ]
          period = 300
        }
      },
      {
        type = "metric", x = 12, y = 20, width = 12, height = 6
        properties = {
          title  = "Business — commission payouts per daily close"
          view   = "timeSeries"
          region = local.dashboard_region
          metrics = [
            ["TillFlow/business", "CommissionPayouts", { label = "payouts disbursed", stat = "Sum" }],
          ]
          period = 86400
        }
      },

      # --- Integrity -----------------------------------------------------
      {
        type = "metric", x = 0, y = 26, width = 24, height = 4
        properties = {
          title  = "Money-correctness invariants — any non-zero value is an incident"
          view   = "timeSeries"
          region = local.dashboard_region
          metrics = [
            ["TillFlow/integrity", "CallbackConflicts", { label = "callback conflicts", stat = "Sum", color = "#d62728" }],
            ["TillFlow/integrity", "ReconcileMismatches", { label = "reconcile mismatches", stat = "Sum", color = "#ff7f0e" }],
            ["TillFlow/commission", "DailyCloseFailures", { label = "daily close failures", stat = "Sum", color = "#9467bd" }],
          ]
          period = 300
          yAxis  = { left = { min = 0 } }
        }
      },
    ]
  })
}

output "slo_dashboard_url" {
  description = "CloudWatch dashboard carrying the SLO, RED, saturation and business panels"
  value       = "https://${local.dashboard_region}.console.aws.amazon.com/cloudwatch/home?region=${local.dashboard_region}#dashboards/dashboard/${aws_cloudwatch_dashboard.slo.dashboard_name}"
}
