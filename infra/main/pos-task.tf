resource "aws_ecs_task_definition" "pos" {
  family                   = "${local.name_prefix}-pos"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.pos_execution.arn
  task_role_arn            = aws_iam_role.pos_task.arn

  container_definitions = jsonencode([
    {
      name      = "pos"
      image     = "${local.account_id}.dkr.ecr.us-east-2.amazonaws.com/devops-g2/pos@sha256:246eef859af48dc83f787f0dad764b682b1460bea9ce17a4a206ad536b0fb203"
      essential = true
      portMappings = [
        { containerPort = 3002, protocol = "tcp" }
      ]
      environment = [
        { name = "HOST", value = "0.0.0.0" },
        { name = "PORT", value = "3002" },
        { name = "PAYMENTS_BASE_URL", value = "http://${aws_lb.main.dns_name}" },
        { name = "POS_STORE", value = "postgres" },
        { name = "POS_CACHE", value = "redis" },
        # rediss://, not redis:// — the replication group has transit
        # encryption enabled, and loadConfig rejects a plain scheme at startup
        # rather than letting POS degrade silently to Postgres forever.
        { name = "CACHE_URL", value = "rediss://${aws_elasticache_replication_group.main.primary_endpoint_address}:6379" },
        { name = "CACHE_TTL_SECONDS", value = "60" },
        { name = "OTEL_SERVICE_NAME", value = "pos" },
        { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = "http://localhost:4318" },
        { name = "OTEL_EXPORTER_OTLP_PROTOCOL", value = "http/protobuf" }
      ]
      secrets = [
        { name = "SERVICE_AUTH_SECRET", valueFrom = aws_secretsmanager_secret.service_auth.arn },
        { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.pos.name
          "awslogs-region"        = "us-east-2"
          "awslogs-stream-prefix" = "pos"
        }
      }
      healthCheck = {
        command     = ["CMD-SHELL", "wget -q --spider http://localhost:3002/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 10
      }
    },
    {
      name      = "adot-collector"
      image     = "public.ecr.aws/aws-observability/aws-otel-collector:latest"
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
          "awslogs-group"         = aws_cloudwatch_log_group.pos.name
          "awslogs-region"        = "us-east-2"
          "awslogs-stream-prefix" = "adot"
        }
      }
    }
  ])

  tags = merge(local.common_tags, { service = "pos" })
}

resource "aws_ecs_service" "pos" {
  name            = "${local.name_prefix}-pos"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.pos.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.ecs_tasks.id]
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.pos.arn
    container_name   = "pos"
    container_port   = 3002
  }

  lifecycle {
    ignore_changes = [task_definition]
  }

  depends_on = [aws_lb_listener_rule.pos]

  tags = merge(local.common_tags, { service = "pos" })
}
