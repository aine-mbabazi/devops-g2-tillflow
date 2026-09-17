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

# The full connection string, assembled from the generated password and the
# instance endpoint. Stored as one secret so a task only needs a single
# valueFrom, and rotating the password (a future change) rotates the URL too.
resource "aws_secretsmanager_secret" "database_url" {
  name = "${local.name_prefix}/database-url"
  tags = merge(local.common_tags, { service = "shared" })
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id     = aws_secretsmanager_secret.database_url.id
  secret_string = "postgresql://${aws_db_instance.main.username}:${random_password.db.result}@${aws_db_instance.main.address}:5432/${aws_db_instance.main.db_name}"

  lifecycle {
    ignore_changes = [secret_string]
  }
}
