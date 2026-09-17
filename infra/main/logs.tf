resource "aws_cloudwatch_log_group" "payments" {
  name              = "/${local.name_prefix}/payments"
  retention_in_days = 14

  tags = merge(local.common_tags, { service = "payments" })
}
resource "aws_cloudwatch_log_group" "pos" {
  name              = "/${local.name_prefix}/pos"
  retention_in_days = 14
  tags              = merge(local.common_tags, { service = "pos" })
}

resource "aws_cloudwatch_log_group" "commission" {
  name              = "/${local.name_prefix}/commission"
  retention_in_days = 14
  tags              = merge(local.common_tags, { service = "commission" })
}
