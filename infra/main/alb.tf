resource "aws_security_group" "alb" {
  name_prefix = "${local.name_prefix}-alb-sg-"
  description = "ALB security group - allows inbound HTTP from within VPC only"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTP from within VPC only"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = [aws_vpc.main.cidr_block]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, { Name = "${local.name_prefix}-alb-sg", service = "networking" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_lb" "main" {
  name               = "${local.name_prefix}-alb"
  internal           = true
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.private[*].id

  tags = merge(local.common_tags, { Name = "${local.name_prefix}-alb", service = "networking" })
}

# Placeholder listener — returns 404 until per-service target groups and
# listener rules are added when the first real service is deployed.
resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "No service configured for this path yet"
      status_code  = "404"
    }
  }
}
