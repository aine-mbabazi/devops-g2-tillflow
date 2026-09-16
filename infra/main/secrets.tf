resource "aws_secretsmanager_secret" "service_auth" {
  name = "${local.name_prefix}/service-auth-secret"
  tags = merge(local.common_tags, { service = "shared" })
}

resource "aws_secretsmanager_secret_version" "service_auth" {
  secret_id     = aws_secretsmanager_secret.service_auth.id
  secret_string = var.service_auth_secret_value
  lifecycle {
    ignore_changes = [secret_string]
  }
}
