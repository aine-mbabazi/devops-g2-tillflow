resource "aws_lb_target_group" "web" {
  name        = "${local.name_prefix}-web-tg"
  port        = 3003
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  # Liveness, not readiness — same rationale as payments-service.tf: web's
  # /ready reflects whether POS and Payments are reachable, a dependency
  # shared by every web task. At desired_count = 1 there is no healthy peer
  # to drain to, so a POS/Payments outage would crash-loop the one (otherwise
  # perfectly fine) web task forever, buying nothing. /ready still exists and
  # is still useful for operators and the synthetic probe — just not for
  # deciding whether to kill a task.
  health_check {
    path                = "/health"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = merge(local.common_tags, { service = "web" })
}

# Distinct /web* prefix, deliberately not overlapping POS's /sales* or
# Payments' /payments* on this same shared ALB (alb.tf, pos-service.tf,
# payments-service.tf) — web's own public routes proxy to those services
# under identical path names, so a public rule matching /sales* here would
# either shadow or collide with POS's own rule for the same paths.
resource "aws_lb_listener_rule" "web" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 300

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }

  condition {
    path_pattern {
      values = ["/web*"]
    }
  }

  tags = merge(local.common_tags, { service = "web" })
}

resource "aws_ecs_service" "web" {
  name            = "${local.name_prefix}-web"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.web.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.ecs_tasks.id]
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 3003
  }

  # The release-web workflow registers new task definition revisions and
  # calls update-service directly; Terraform must not fight that by forcing
  # the service back onto whatever revision this file's placeholder image
  # produced at the last apply.
  lifecycle {
    ignore_changes = [task_definition]
  }

  depends_on = [aws_lb_listener_rule.web]

  tags = merge(local.common_tags, { service = "web" })
}
