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

resource "aws_ecr_repository" "web" {
  name                 = "${local.name_prefix}/web"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = merge(local.common_tags, { service = "web" })
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

output "web_ecr_repository_url" {
  value = aws_ecr_repository.web.repository_url
}

# Registry-level ENHANCED scanning, which is what the brief asks for.
# scan_on_push above is basic scanning: it only reads OS package manifests, and
# only at push time. Enhanced scanning hands the images to Amazon Inspector,
# which also covers application dependencies (the npm tree these images are
# almost entirely made of) and — the part that matters operationally —
# re-scans continuously as new CVEs are published, rather than freezing the
# verdict at the moment of push.
#
# This is a registry-wide setting, not per repository, so it is declared once.
# The filter is a wildcard because the account holds only this group's repos.
#
# NOTE for the first apply: switching a registry to ENHANCED activates Amazon
# Inspector for ECR. If the apply fails with an inspector2 AccessDenied, the
# apply role needs inspector2:Enable adding — it is not in the allow-list
# today, and it cannot be added speculatively without knowing whether Inspector
# is already active in this account.
resource "aws_ecr_registry_scanning_configuration" "main" {
  scan_type = "ENHANCED"

  rule {
    scan_frequency = "CONTINUOUS_SCAN"
    repository_filter {
      filter      = "${local.name_prefix}/*"
      filter_type = "WILDCARD"
    }
  }
}
