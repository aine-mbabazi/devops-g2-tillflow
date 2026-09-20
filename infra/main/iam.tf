data "aws_iam_policy_document" "ecs_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# ─── Payments ───────────────────────────────────────────────────────────────
resource "aws_iam_role" "payments_execution" {
  name               = "${local.name_prefix}-payments-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume_role.json
  tags               = merge(local.common_tags, { service = "payments" })
}

resource "aws_iam_role_policy_attachment" "payments_execution" {
  role       = aws_iam_role.payments_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "payments_task" {
  name               = "${local.name_prefix}-payments-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume_role.json
  tags               = merge(local.common_tags, { service = "payments" })
}

# ADOT sidecar needs permission to export traces/metrics to CloudWatch and X-Ray
resource "aws_iam_role_policy_attachment" "payments_task_xray" {
  role       = aws_iam_role.payments_task.name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

resource "aws_iam_role_policy_attachment" "payments_task_cloudwatch" {
  role       = aws_iam_role.payments_task.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

# ─── POS ────────────────────────────────────────────────────────────────────
resource "aws_iam_role" "pos_execution" {
  name               = "${local.name_prefix}-pos-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume_role.json
  tags               = merge(local.common_tags, { service = "pos" })
}

resource "aws_iam_role_policy_attachment" "pos_execution" {
  role       = aws_iam_role.pos_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "pos_task" {
  name               = "${local.name_prefix}-pos-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume_role.json
  tags               = merge(local.common_tags, { service = "pos" })
}

resource "aws_iam_role_policy_attachment" "pos_task_xray" {
  role       = aws_iam_role.pos_task.name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

resource "aws_iam_role_policy_attachment" "pos_task_cloudwatch" {
  role       = aws_iam_role.pos_task.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

# ─── Commission ─────────────────────────────────────────────────────────────
resource "aws_iam_role" "commission_execution" {
  name               = "${local.name_prefix}-commission-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume_role.json
  tags               = merge(local.common_tags, { service = "commission" })
}

resource "aws_iam_role_policy_attachment" "commission_execution" {
  role       = aws_iam_role.commission_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "commission_task" {
  name               = "${local.name_prefix}-commission-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume_role.json
  tags               = merge(local.common_tags, { service = "commission" })
}

resource "aws_iam_role_policy_attachment" "commission_task_xray" {
  role       = aws_iam_role.commission_task.name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

resource "aws_iam_role_policy_attachment" "commission_task_cloudwatch" {
  role       = aws_iam_role.commission_task.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

# ─── Web ────────────────────────────────────────────────────────────────────
resource "aws_iam_role" "web_execution" {
  name               = "${local.name_prefix}-web-exec"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume_role.json
  tags               = merge(local.common_tags, { service = "web" })
}

resource "aws_iam_role_policy_attachment" "web_execution" {
  role       = aws_iam_role.web_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "web_task" {
  name               = "${local.name_prefix}-web-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume_role.json
  tags               = merge(local.common_tags, { service = "web" })
}

resource "aws_iam_role_policy_attachment" "web_task_xray" {
  role       = aws_iam_role.web_task.name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

resource "aws_iam_role_policy_attachment" "web_task_cloudwatch" {
  role       = aws_iam_role.web_task.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

data "aws_iam_policy_document" "read_service_auth_secret" {
  statement {
    sid       = "ReadServiceAuth"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.service_auth.arn]
  }
  # The task definitions pass DATABASE_URL from this secret as a valueFrom,
  # so the execution role must be able to read it before the container starts.
  statement {
    sid       = "ReadDatabaseUrl"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.database_url.arn]
  }
}

resource "aws_iam_role_policy" "payments_execution_secrets" {
  name   = "${local.name_prefix}-payments-exec-secrets"
  role   = aws_iam_role.payments_execution.id
  policy = data.aws_iam_policy_document.read_service_auth_secret.json
}

resource "aws_iam_role_policy" "pos_execution_secrets" {
  name   = "${local.name_prefix}-pos-exec-secrets"
  role   = aws_iam_role.pos_execution.id
  policy = data.aws_iam_policy_document.read_service_auth_secret.json
}

resource "aws_iam_role_policy" "commission_execution_secrets" {
  name   = "${local.name_prefix}-commission-exec-secrets"
  role   = aws_iam_role.commission_execution.id
  policy = data.aws_iam_policy_document.read_service_auth_secret.json
}

# web has no database of its own, so its execution role gets only the
# service-auth secret — not the broader read_service_auth_secret document
# above, which also grants database_url. Least privilege for a stateless proxy.
data "aws_iam_policy_document" "read_service_auth_secret_only" {
  statement {
    sid       = "ReadServiceAuth"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.service_auth.arn]
  }
}

resource "aws_iam_role_policy" "web_execution_secrets" {
  name   = "${local.name_prefix}-web-exec-secrets"
  role   = aws_iam_role.web_execution.id
  policy = data.aws_iam_policy_document.read_service_auth_secret_only.json
}
