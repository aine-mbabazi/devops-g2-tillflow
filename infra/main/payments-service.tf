resource "aws_lb_target_group" "payments" {
  name        = "${local.name_prefix}-payments-tg"
  port        = 3001
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip" # required for Fargate

  # Liveness, not readiness. ECS derives task health from target health, so a
  # dependency-aware probe here does not drain a task, it replaces it — and
  # every task shares one database, so a Postgres outage fails them all
  # together and crash-loops the service for as long as the outage lasts. At
  # desired_count = 1 there is no healthy peer to drain to either, so pointing
  # this at /ready would cost availability and buy nothing.
  #
  # /ready still exists and is still routed below, for the synthetic probe and
  # for operators — just not for deciding whether to kill a task.
  health_check {
    path                = "/health"
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

  tags = merge(local.common_tags, { service = "payments" })
}
