resource "aws_cloudwatch_log_group" "payments" {
  name              = "/${local.name_prefix}/payments"
  retention_in_days = 14

  tags = merge(local.common_tags, { service = "payments" })
}
