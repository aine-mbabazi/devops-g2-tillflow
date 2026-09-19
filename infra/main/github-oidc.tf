data "aws_iam_openid_connect_provider" "github" {
  url = "https://token.actions.githubusercontent.com"
}

data "aws_kms_key" "s3" {
  key_id = "alias/${local.name_prefix}-s3-key"
}

data "aws_iam_policy_document" "github_actions_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [data.aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:job_workflow_ref"
      values = [
        "aine-mbabazi/devops-g2-tillflow/.github/workflows/pr.yml@*",
        "aine-mbabazi/devops-g2-tillflow/.github/workflows/release.yml@*",
        "aine-mbabazi/devops-g2-tillflow/.github/workflows/release-pos.yml@*",
        "aine-mbabazi/devops-g2-tillflow/.github/workflows/release-commission.yml@*",
        # Infra Apply's plan job. Its apply job assumes devops-g2-ci-apply
        # instead; planning stays on this read-only role.
        "aine-mbabazi/devops-g2-tillflow/.github/workflows/infra-apply.yml@*",
      ]
    }
  }
}

resource "aws_iam_role" "github_actions_deploy" {
  name               = "${local.name_prefix}-ci-deploy"
  assume_role_policy = data.aws_iam_policy_document.github_actions_assume.json
  tags               = merge(local.common_tags, { service = "ci-cd" })
}

data "aws_iam_policy_document" "github_actions_permissions" {
  statement {
    sid    = "ECRPushPull"
    effect = "Allow"
    actions = [
      "ecr:GetAuthorizationToken",
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
      "ecr:PutImage",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "ECSDeploy"
    effect = "Allow"
    actions = [
      "ecs:DescribeServices",
      "ecs:DescribeTaskDefinition",
      "ecs:RegisterTaskDefinition",
      "ecs:UpdateService",
    ]
    resources = ["*"]
  }

  statement {
    sid     = "PassRoleToECS"
    effect  = "Allow"
    actions = ["iam:PassRole"]
    resources = [
      aws_iam_role.payments_execution.arn,
      aws_iam_role.payments_task.arn,
      aws_iam_role.pos_execution.arn,
      aws_iam_role.pos_task.arn,
      aws_iam_role.commission_execution.arn,
      aws_iam_role.commission_task.arn,
    ]
  }

  statement {
    sid    = "TerraformState"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:ListBucket",
    ]
    resources = [
      "arn:aws:s3:::${local.name_prefix}-tillflow-tfstate-${local.account_id}",
      "arn:aws:s3:::${local.name_prefix}-tillflow-tfstate-${local.account_id}/*",
    ]
  }

  statement {
    sid       = "TerraformLock"
    effect    = "Allow"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]
    resources = ["arn:aws:dynamodb:us-east-2:${local.account_id}:table/${local.name_prefix}-tflock"]
  }
  statement {
    sid    = "KMSDecryptState"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey",
    ]
    resources = [data.aws_kms_key.s3.arn]
  }
  statement {
    sid    = "TerraformReadForPlan"
    effect = "Allow"
    actions = [
      "apigateway:GET",
      # Needed once these resources exist in state: every subsequent plan
      # refreshes them, and a plan that cannot read a managed resource fails
      # before it can report drift.
      "cloudwatch:Describe*",
      "cloudwatch:GetDashboard",
      "cloudwatch:ListDashboards",
      "cloudwatch:ListTagsForResource",
      "sns:GetTopicAttributes",
      "sns:GetSubscriptionAttributes",
      "sns:ListTagsForResource",
      "sns:ListSubscriptionsByTopic",
      "lambda:GetFunction",
      "lambda:GetFunctionConfiguration",
      "lambda:GetPolicy",
      "lambda:ListVersionsByFunction",
      "kms:ListAliases",
      "kms:GetKeyRotationStatus",
      "scheduler:GetSchedule",
      "synthetics:GetCanary",
      "synthetics:ListTagsForResource",
      "ec2:Describe*",
      "ecs:Describe*",
      "ecs:List*",
      "ecs:ListTagsForResource",
      "ecr:Describe*",
      "ecr:GetRepositoryPolicy",
      "ecr:ListTagsForResource",
      "elasticloadbalancing:Describe*",
      "iam:GetRole",
      "iam:GetRolePolicy",
      "iam:ListRolePolicies",
      "iam:ListRoleTags",
      "iam:ListAttachedRolePolicies",
      "iam:ListOpenIDConnectProviders",
      "iam:GetOpenIDConnectProvider",
      "logs:Describe*",
      "logs:ListTagsForResource",
      "dynamodb:DescribeTable",
      "dynamodb:ListTagsOfResource",
      "rds:Describe*",
      "rds:ListTagsForResource",
      "kms:DescribeKey",
      "kms:GetKeyPolicy",
      "kms:ListResourceTags",
      "s3:GetBucket*",
      "s3:GetEncryptionConfiguration",
      "s3:GetLifecycleConfiguration",
    ]
    resources = ["*"]
  }

  # Read-only: the plan job (both pr.yml/release.yml and infra-apply.yml's
  # plan stage) needs to refresh aws_secretsmanager_secret.service_auth and
  # its version, but never writes to it — that's the apply role's job.
  statement {
    sid    = "TerraformReadSecrets"
    effect = "Allow"
    actions = [
      "secretsmanager:DescribeSecret",
      "secretsmanager:GetSecretValue",
      "secretsmanager:ListSecretVersionIds",
      "secretsmanager:GetResourcePolicy",
    ]
    resources = ["arn:aws:secretsmanager:us-east-2:${local.account_id}:secret:${local.name_prefix}/*"]
  }
}

resource "aws_iam_role_policy" "github_actions" {
  name   = "${local.name_prefix}-ci-deploy-policy"
  role   = aws_iam_role.github_actions_deploy.id
  policy = data.aws_iam_policy_document.github_actions_permissions.json
}

output "github_actions_role_arn" {
  value = aws_iam_role.github_actions_deploy.arn
}
