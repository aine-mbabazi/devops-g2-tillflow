resource "aws_lb_target_group" "payments" {
  name        = "${local.name_prefix}-payments-tg"
  port        = 3001
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip" # required for Fargate

  # Probes /ready so a task that cannot reach Postgres stops taking traffic.
  # ECS derives task health from target health, so a sustained database outage
  # fails every task and cycles them rather than only draining them; the
  # service sets a health check grace period to keep that from killing a deploy
  # started mid-outage.
  health_check {
    path                = "/ready"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = merge(local.common_tags, { service = "payments" })
}

resource "aws_lb_listener_rule" "payments" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.payments.arn
  }

  condition {
    path_pattern {
      values = ["/payments*", "/health", "/ready"]
    }
  }
}
