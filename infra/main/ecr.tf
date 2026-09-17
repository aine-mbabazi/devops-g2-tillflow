resource "aws_ecr_repository" "payments" {
  name                 = "${local.name_prefix}/payments"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = merge(local.common_tags, { service = "payments" })
}

resource "aws_ecr_repository" "pos" {
  name                 = "${local.name_prefix}/pos"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = merge(local.common_tags, { service = "pos" })
}

resource "aws_ecr_repository" "commission" {
  name                 = "${local.name_prefix}/commission"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = merge(local.common_tags, { service = "commission" })
}

output "payments_ecr_repository_url" {
  value = aws_ecr_repository.payments.repository_url
}

output "pos_ecr_repository_url" {
  value = aws_ecr_repository.pos.repository_url
}

output "commission_ecr_repository_url" {
  value = aws_ecr_repository.commission.repository_url
}
