resource "aws_ecr_repository" "payments" {
  name                 = "${local.name_prefix}/payments"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = merge(local.common_tags, { service = "payments" })
}

output "payments_ecr_repository_url" {
  value = aws_ecr_repository.payments.repository_url
}
