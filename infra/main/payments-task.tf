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
      name                   = "payments"
      readonlyRootFilesystem = true
      mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
      image                  = "${local.account_id}.dkr.ecr.us-east-2.amazonaws.com/devops-g2/payments@sha256:7e23708cc0e1a412e2b471c38a1d8f4638f0bc3f45c040840cbdb3f0682f173b"
      essential              = true
      portMappings = [
        { containerPort = 3001, protocol = "tcp" }
      ]
      environment = [
        { name = "HOST", value = "0.0.0.0" },
        { name = "PORT", value = "3001" },
        { name = "DARAJA_MODE", value = "fake" },
        { name = "PAYMENT_STORE", value = "postgres" },
        { name = "OTEL_SERVICE_NAME", value = "payments" },
        { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = "http://localhost:4318" },
        { name = "OTEL_EXPORTER_OTLP_PROTOCOL", value = "http/protobuf" }
      ]
      # No dependsOn on the collector, deliberately. Any condition — START or
      # HEALTHY — leaves payments unable to start when the collector cannot,
      # which is the failure it was supposed to prevent. The SDK's batch
      # processor queues spans until the collector answers, so starting in
      # parallel loses nothing.
      secrets = [
        { name = "SERVICE_AUTH_SECRET", valueFrom = aws_secretsmanager_secret.service_auth.arn },
        { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn }
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
      name                   = "adot-collector"
      readonlyRootFilesystem = true
      mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
      image                  = "public.ecr.aws/aws-observability/aws-otel-collector:v0.43.3"
      # Non-essential so a collector crash does not kill the task. With no
      # start-order dependency either, a broken collector costs telemetry and
      # nothing else.
      essential = false
      portMappings = [
        { containerPort = 4317, protocol = "tcp" },
        { containerPort = 4318, protocol = "tcp" }
      ]
      environment = [
        { name = "AOT_CONFIG_CONTENT", value = templatefile("${path.module}/adot-config.yaml.tftpl", {
          service   = "payments"
          log_group = aws_cloudwatch_log_group.payments.name
        }) }
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


  # Fargate does not support linuxParameters.tmpfs, so a read-only root
  # filesystem needs a real mount for anything the runtime writes. This is an
  # empty, non-persistent volume backed by the task's ephemeral storage: it
  # lives for the task's lifetime and holds nothing worth keeping.
  volume {
    name = "tmp"
  }

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

  # Covers container boot — image pull, OTel SDK init, then listen — before the
  # load balancer starts counting failures against a task.
  health_check_grace_period_seconds = 120

  load_balancer {
    target_group_arn = aws_lb_target_group.payments.arn
    container_name   = "payments"
    container_port   = 3001
  }
  lifecycle {
    ignore_changes = [task_definition]
  }


  depends_on = [aws_lb_listener_rule.payments]

  tags = merge(local.common_tags, { service = "payments" })
}
