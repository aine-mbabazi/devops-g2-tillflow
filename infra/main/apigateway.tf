# Public front door: API Gateway -> VPC Link -> internal ALB -> ECS.
# The ALB stays internal; API Gateway is the only path in from the internet.

resource "aws_security_group" "vpc_link" {
  name_prefix = "${local.name_prefix}-vpc-link-sg-"
  description = "VPC Link ENIs - egress to the internal ALB"
  vpc_id      = aws_vpc.main.id

  egress {
    description     = "To the internal ALB"
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  tags = merge(local.common_tags, { Name = "${local.name_prefix}-vpc-link-sg", service = "networking" })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_apigatewayv2_vpc_link" "main" {
  name               = "${local.name_prefix}-vpc-link"
  subnet_ids         = aws_subnet.private[*].id
  security_group_ids = [aws_security_group.vpc_link.id]

  tags = merge(local.common_tags, { service = "networking" })
}

resource "aws_apigatewayv2_api" "main" {
  name          = "${local.name_prefix}-api"
  protocol_type = "HTTP"

  tags = merge(local.common_tags, { service = "networking" })
}

# Private integration to the ALB listener. Routing between services is the
# listener's job, so the gateway forwards everything and the ALB rules decide.
resource "aws_apigatewayv2_integration" "alb" {
  api_id             = aws_apigatewayv2_api.main.id
  integration_type   = "HTTP_PROXY"
  integration_method = "ANY"
  integration_uri    = aws_lb_listener.http.arn
  connection_type    = "VPC_LINK"
  connection_id      = aws_apigatewayv2_vpc_link.main.id

  payload_format_version = "1.0"
}

resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.alb.id}"
}

resource "aws_cloudwatch_log_group" "apigateway" {
  name              = "/${local.name_prefix}/apigateway"
  retention_in_days = 30

  tags = merge(local.common_tags, { service = "networking" })
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.apigateway.arn
    format = jsonencode({
      requestId        = "$context.requestId"
      requestTime      = "$context.requestTime"
      httpMethod       = "$context.httpMethod"
      path             = "$context.path"
      status           = "$context.status"
      responseLatency  = "$context.responseLatency"
      integrationError = "$context.integrationErrorMessage"
      sourceIp         = "$context.identity.sourceIp"
    })
  }

  tags = merge(local.common_tags, { service = "networking" })
}
