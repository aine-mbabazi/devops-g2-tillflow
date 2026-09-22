# Commission is a one-shot worker, not a long-running service: EventBridge
# Scheduler runs this task once per day, it exits, and the next schedule
# starts a fresh task. There is deliberately no aws_ecs_service here.
resource "aws_ecs_task_definition" "commission" {
  family                   = "${local.name_prefix}-commission"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.commission_execution.arn
  task_role_arn            = aws_iam_role.commission_task.arn

  container_definitions = jsonencode([
    {
      name                   = "commission"
      readonlyRootFilesystem = true
      mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
      # Placeholder digest: the release-commission workflow registers a new
      # revision with the real digest on first deploy. Until then the
      # scheduled task cannot pull an image, which is why the schedule below
      # starts DISABLED.
      image     = "${local.account_id}.dkr.ecr.us-east-2.amazonaws.com/devops-g2/commission@sha256:0000000000000000000000000000000000000000000000000000000000000000"
      essential = true
      environment = [
        { name = "POS_BASE_URL", value = "http://${aws_lb.main.dns_name}" },
        { name = "PAYMENTS_BASE_URL", value = "http://${aws_lb.main.dns_name}" },
        { name = "TENANT_IDS", value = var.tenant_ids },
        { name = "LEDGER_STORE", value = "postgres" },
      ]
      secrets = [
        { name = "SERVICE_AUTH_SECRET", valueFrom = aws_secretsmanager_secret.service_auth.arn },
        { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.commission.name
          "awslogs-region"        = "us-east-2"
          "awslogs-stream-prefix" = "commission"
        }
      }
    },
    {
      name                   = "adot-collector"
      image                  = "public.ecr.aws/aws-observability/aws-otel-collector:v0.43.3"
      essential              = false
      readonlyRootFilesystem = true
      mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
      portMappings = [
        { containerPort = 4317, protocol = "tcp" },
        { containerPort = 4318, protocol = "tcp" },
      ]
      environment = [
        { name = "AOT_CONFIG_CONTENT", value = templatefile("${path.module}/adot-config.yaml.tftpl", {
          service   = "commission"
          log_group = aws_cloudwatch_log_group.commission.name
        }) }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.commission.name
          "awslogs-region"        = "us-east-2"
          "awslogs-stream-prefix" = "adot"
        }
      }
    },
  ])

  # The brief requires every backend task to run application + ADOT sidecar,
  # and Commission was the one that did not. It is also the task where a
  # sidecar is most awkward: this is a one-shot worker, not a service. The
  # collector is non-essential, so when the worker exits the task stops
  # regardless of the collector's state — but spans buffered in the last
  # moments of a run can be lost, because nothing waits for the collector to
  # flush. Accepted: the daily close's evidence is its ledger writes and its
  # structured logs, both durable, with traces as supporting detail.

  volume {
    name = "tmp"
  }

  tags = merge(local.common_tags, { service = "commission" })

  # The release workflow registers a new revision with the real image digest.
  # Without this, a later terraform apply would make the placeholder revision
  # the latest again and break the deployed image.
  lifecycle {
    ignore_changes = [container_definitions]
  }
}

# EventBridge Scheduler runs the worker once per day. 02:00 UTC is 05:00 EAT,
# which leaves over an hour of headroom before the SLO's 06:30 EAT terminal
# deadline. A retry of the same schedule reuses the same commissionRunId
# (derived from the UTC date in run.js), so a second attempt cannot double-pay.
resource "aws_scheduler_schedule" "commission_daily" {
  name        = "${local.name_prefix}-commission-daily"
  description = "Commission daily close, once per day at 02:00 UTC (05:00 EAT)"
  # Enabled 2026-09-22. The precondition in the original comment — "enable
  # after the first image is pushed to ECR" — was met on 2026-09-20, when
  # Release Commission succeeded twice, but the flag was never flipped. While
  # it stayed DISABLED the daily close never ran on schedule, which made the
  # Commission SLI ("eligible payouts reach terminal state by 06:30 EAT")
  # unmeasurable and devops-g2-commission-close-failed unable to fire: a close
  # that never starts never fails.
  #
  # Enabling this starts a real daily B2C close against the Daraja sandbox at
  # 02:00 UTC / 05:00 EAT. A re-run is safe — the commissionRunId derives from
  # the UTC date, so retries reuse the same idempotency keys and cannot
  # double-pay — but the first scheduled run is worth watching.
  state = "ENABLED"

  schedule_expression          = "cron(0 2 * * ? *)"
  schedule_expression_timezone = "UTC"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_ecs_cluster.main.arn
    role_arn = aws_iam_role.commission_scheduler.arn

    ecs_parameters {
      # Family ARN (no revision) so the schedule always runs the latest
      # ACTIVE revision the release workflow registered.
      task_definition_arn = aws_ecs_task_definition.commission.arn_without_revision
      launch_type         = "FARGATE"

      network_configuration {
        subnets          = aws_subnet.private[*].id
        security_groups  = [aws_security_group.ecs_tasks.id]
        assign_public_ip = false
      }
    }

    retry_policy {
      maximum_retry_attempts       = 2
      maximum_event_age_in_seconds = 3600
    }
  }
}

# Scheduler needs its own role to call ecs:RunTask and pass the task's roles
# to the task it starts. This is distinct from the CI deploy role.
resource "aws_iam_role" "commission_scheduler" {
  name = "${local.name_prefix}-commission-scheduler"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = merge(local.common_tags, { service = "commission" })
}

resource "aws_iam_role_policy" "commission_scheduler" {
  name = "${local.name_prefix}-commission-scheduler"
  role = aws_iam_role.commission_scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "ecs:RunTask"
        Resource = ["${aws_ecs_task_definition.commission.arn_without_revision}:*"]
      },
      {
        Effect   = "Allow"
        Action   = "iam:PassRole"
        Resource = [aws_iam_role.commission_execution.arn, aws_iam_role.commission_task.arn]
      },
    ]
  })
}
