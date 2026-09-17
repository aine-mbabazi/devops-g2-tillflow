resource "aws_lb_target_group" "pos" {
  name        = "${local.name_prefix}-pos-tg"
  port        = 3002
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip"

  health_check {
    path                = "/health"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = merge(local.common_tags, { service = "pos" })
}

resource "aws_lb_listener_rule" "pos" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 200

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.pos.arn
  }

  condition {
    path_pattern {
      values = ["/sales*"]
    }
  }
}
