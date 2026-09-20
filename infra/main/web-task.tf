resource "aws_ecs_task_definition" "web" {
  family                   = "${local.name_prefix}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.web_execution.arn
  task_role_arn            = aws_iam_role.web_task.arn

  container_definitions = jsonencode([
    {
      name                   = "web"
      readonlyRootFilesystem = true
      mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
      # Placeholder digest, same bootstrap pattern as Commission
      # (commission-task.tf): the release-web workflow registers a new
      # revision with the real digest on first deploy. Until then the
      # service cannot pull an image and sits with zero running tasks —
      # harmless, since desired_count elsewhere is unaffected and this is a
      # brand-new service with no existing traffic depending on it.
      image     = "${local.account_id}.dkr.ecr.us-east-2.amazonaws.com/devops-g2/web@sha256:0000000000000000000000000000000000000000000000000000000000000000"
      essential = true
      portMappings = [
        { containerPort = 3003, protocol = "tcp" }
      ]
      environment = [
        { name = "HOST", value = "0.0.0.0" },
        { name = "PORT", value = "3003" },
        # web reaches POS and Payments the same way POS already reaches
        # Payments: through the shared internal ALB, at their own
        # un-prefixed paths (/sales*, /payments*).
        { name = "POS_BASE_URL", value = "http://${aws_lb.main.dns_name}" },
        { name = "PAYMENTS_BASE_URL", value = "http://${aws_lb.main.dns_name}" },
        { name = "OTEL_SERVICE_NAME", value = "web" },
        { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = "http://localhost:4318" },
        { name = "OTEL_EXPORTER_OTLP_PROTOCOL", value = "http/protobuf" }
      ]
      secrets = [
        { name = "SERVICE_AUTH_SECRET", valueFrom = aws_secretsmanager_secret.service_auth.arn }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.web.name
          "awslogs-region"        = "us-east-2"
          "awslogs-stream-prefix" = "web"
        }
      }
      healthCheck = {
        command     = ["CMD-SHELL", "wget -q --spider http://localhost:3003/health || exit 1"]
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
      image                  = "public.ecr.aws/aws-observability/aws-otel-collector:latest"
      essential              = false
      portMappings = [
        { containerPort = 4317, protocol = "tcp" },
        { containerPort = 4318, protocol = "tcp" }
      ]
      environment = [
        { name = "AOT_CONFIG_CONTENT", value = templatefile("${path.module}/adot-config.yaml.tftpl", {
          service   = "web"
          log_group = aws_cloudwatch_log_group.web.name
        }) }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.web.name
          "awslogs-region"        = "us-east-2"
          "awslogs-stream-prefix" = "adot"
        }
      }
    }
  ])

  # Fargate does not support linuxParameters.tmpfs, so a read-only root
  # filesystem needs a real mount for anything the runtime writes.
  volume {
    name = "tmp"
  }

  tags = merge(local.common_tags, { service = "web" })
}
