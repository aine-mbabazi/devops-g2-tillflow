data "aws_iam_policy_document" "ecs_assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

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
