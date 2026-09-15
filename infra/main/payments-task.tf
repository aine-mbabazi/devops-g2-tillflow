resource "aws_ecs_task_definition" "payments" {
  family                   = "${local.name_prefix}-payments"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.payments_execution.arn
  task_role_arn            = aws_iam_role.payments_task.arn

  container_definitions = jsonencode([
    {
      name      = "payments"
      image     = "240462142849.dkr.ecr.us-east-2.amazonaws.com/devops-g2/payments@sha256:7e23708cc0e1a412e2b471c38a1d8f4638f0bc3f45c040840cbdb3f0682f173b"
      essential = true
      portMappings = [
        { containerPort = 3001, protocol = "tcp" }
      ]
      environment = [
        { name = "HOST", value = "0.0.0.0" },
        { name = "PORT", value = "3001" },
        { name = "DARAJA_MODE", value = "fake" },
        { name = "OTEL_SERVICE_NAME", value = "payments" },
        { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = "http://localhost:4318" },
        { name = "OTEL_EXPORTER_OTLP_PROTOCOL", value = "http/protobuf" }
      ]
      # START, not HEALTHY: gating on the collector's health check would mean a
      # collector that never goes healthy — bad IAM, slow image pull, config
      # typo — stops payments starting at all. Ordering is all that is needed,
      # because the SDK's batch processor queues spans until the collector
      # answers.
      dependsOn = [
        { containerName = "adot-collector", condition = "START" }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.payments.name
          "awslogs-region"        = "us-east-2"
          "awslogs-stream-prefix" = "payments"
        }
      }
      healthCheck = {
        command     = ["CMD-SHELL", "wget -q --spider http://localhost:3001/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 10
      }
    },
    {
      name  = "adot-collector"
      image = "public.ecr.aws/aws-observability/aws-otel-collector:v0.43.3"
      # Non-essential so a collector crash does not kill the task. Paired with
      # the START condition above, a broken collector costs telemetry and
      # nothing else.
      essential = false
      portMappings = [
        { containerPort = 4317, protocol = "tcp" },
        { containerPort = 4318, protocol = "tcp" }
      ]
      environment = [
        { name = "AOT_CONFIG_CONTENT", value = file("${path.module}/adot-config.yaml") }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.payments.name
          "awslogs-region"        = "us-east-2"
          "awslogs-stream-prefix" = "adot"
        }
      }
      healthCheck = {
        command     = ["CMD", "/healthcheck"]
        interval    = 10
        timeout     = 5
        retries     = 3
        startPeriod = 10
      }
    }
  ])

  tags = merge(local.common_tags, { service = "payments" })
}

resource "aws_ecs_service" "payments" {
  name            = "${local.name_prefix}-payments"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.payments.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.ecs_tasks.id]
  }

  # Without a grace period a deploy started while Postgres is down is killed by
  # the load balancer before it can ever report ready, turning an outage into a
  # crash loop.
  health_check_grace_period_seconds = 120

  load_balancer {
    target_group_arn = aws_lb_target_group.payments.arn
    container_name   = "payments"
    container_port   = 3001
  }

  depends_on = [aws_lb_listener_rule.payments]

  tags = merge(local.common_tags, { service = "payments" })
}
