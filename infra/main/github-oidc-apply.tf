# Apply role — separate from devops-g2-ci-deploy so the PR plan job and the
# ECS deploy job stay read-only. Only the Infra Apply workflow can assume this,
# and only after the protected `production` environment is approved.

data "aws_iam_policy_document" "github_apply_assume" {
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
        "aine-mbabazi/devops-g2-tillflow/.github/workflows/infra-apply.yml@*",
      ]
    }
  }
}

resource "aws_iam_role" "github_actions_apply" {
  name               = "${local.name_prefix}-ci-apply"
  assume_role_policy = data.aws_iam_policy_document.github_apply_assume.json
  tags               = merge(local.common_tags, { service = "ci-cd" })
}

data "aws_iam_policy_document" "github_apply_permissions" {
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
    sid    = "StateKMS"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey",
      "kms:DescribeKey",
    ]
    resources = [data.aws_kms_key.s3.arn]
  }

  # EC2/ELB create actions do not support resource-level permissions, so these
  # are account-wide. The account permission boundary is what bounds them.
  statement {
    sid    = "NetworkAndLoadBalancing"
    effect = "Allow"
    actions = [
      "apigateway:*",
      "ec2:*",
      "elasticloadbalancing:*",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "ComputeAndRegistry"
    effect = "Allow"
    actions = [
      "ecs:*",
      "ecr:*",
      "logs:*",
      "application-autoscaling:*",
    ]
    resources = ["*"]
  }

  # Observability and alerting. The CloudWatch actions the alarms and the
  # dashboard need are not resource-scopable as a set — DescribeAlarms and
  # GetDashboard have no resource dimension — so this follows the same
  # account-wide pattern as ecs:*/ec2:* above, bounded by the account
  # permission boundary.
  statement {
    sid    = "Observability"
    effect = "Allow"
    actions = [
      "cloudwatch:*",
      "synthetics:*",
    ]
    resources = ["*"]
  }

  # SNS and Lambda do support resource-level permissions, so they get scoped
  # to the group prefix rather than account-wide.
  statement {
    sid       = "AlertDelivery"
    effect    = "Allow"
    actions   = ["sns:*"]
    resources = ["arn:aws:sns:us-east-2:${local.account_id}:${local.name_prefix}-*"]
  }

  statement {
    sid       = "AlertNotifierFunction"
    effect    = "Allow"
    actions   = ["lambda:*"]
    resources = ["arn:aws:lambda:us-east-2:${local.account_id}:function:${local.name_prefix}-*"]
  }

  # CloudWatch Synthetics does not run a canary directly — it creates a Lambda
  # function and a layer behind the scenes, named cwsyn-<canary>-<uuid>. The
  # principal creating the canary is the principal that must be allowed to
  # manage them, and cwsyn-* does not match the devops-g2-* prefix above, so
  # canary creation failed with CREATE_FAILED / lambda:GetFunctionConfiguration
  # denied on cwsyn-devops-g2-probe-<uuid>.
  #
  # Granted as lambda:* over the cwsyn-* function and layer ARNs rather than
  # enumerating actions. The create path alone needs CreateFunction,
  # GetFunctionConfiguration, UpdateFunctionCode, UpdateFunctionConfiguration,
  # PublishVersion, AddPermission, PublishLayerVersion and GetLayerVersion, and
  # delete and update need more again — enumerating them is how this turns into
  # one failed apply per missing action, which has already cost this project
  # several cycles today.
  statement {
    sid     = "SyntheticsManagedLambda"
    effect  = "Allow"
    actions = ["lambda:*"]
    resources = [
      "arn:aws:lambda:us-east-2:${local.account_id}:function:cwsyn-*",
      "arn:aws:lambda:us-east-2:${local.account_id}:layer:cwsyn-*",
      "arn:aws:lambda:us-east-2:${local.account_id}:layer:cwsyn-*:*",
    ]
  }

  # The canary runtime is delivered as an AWS-owned Lambda layer that lives in
  # an AWS-operated account, so it cannot be scoped to this account's ARNs.
  # Read-only on layer versions.
  statement {
    sid       = "SyntheticsRuntimeLayer"
    effect    = "Allow"
    actions   = ["lambda:GetLayerVersion"]
    resources = ["arn:aws:lambda:us-east-2:*:layer:Synthetics*"]
  }

  # kms:CreateKey cannot be resource-scoped — the key does not exist yet, and
  # there is no ARN to name. The alias and post-creation actions could be
  # scoped, but splitting them across two statements for one key buys nothing.
  # This is the narrowest set that can actually create and manage the alerts
  # key; note it deliberately excludes kms:Decrypt on arbitrary keys.
  statement {
    sid    = "ManageOwnKeys"
    effect = "Allow"
    actions = [
      "kms:CreateKey",
      "kms:CreateAlias",
      "kms:DeleteAlias",
      "kms:ListAliases",
      "kms:PutKeyPolicy",
      "kms:GetKeyRotationStatus",
      "kms:EnableKeyRotation",
      "kms:DisableKeyRotation",
      "kms:ScheduleKeyDeletion",
      "kms:CancelKeyDeletion",
      "kms:TagResource",
      "kms:UntagResource",
      "kms:DescribeKey",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "EnhancedScanning"
    effect = "Allow"
    actions = [
      "inspector2:Enable",
      "inspector2:Disable",
      "inspector2:BatchGetAccountStatus",
    ]
    resources = ["*"]
  }

  # This is the action the 2026-09-17 apply actually died on:
  # "not authorized to perform: scheduler:CreateSchedule".
  statement {
    sid       = "CommissionSchedule"
    effect    = "Allow"
    actions   = ["scheduler:*"]
    resources = ["arn:aws:scheduler:us-east-2:${local.account_id}:schedule/default/${local.name_prefix}-*"]
  }

  # RDS was never in this policy at all, which means the live database was
  # applied out of band rather than by this pipeline. Adding it so a
  # destroy/rebuild is actually reproducible from CI.
  statement {
    sid    = "Database"
    effect = "Allow"
    actions = [
      "rds:*",
    ]
    resources = [
      "arn:aws:rds:us-east-2:${local.account_id}:db:${local.name_prefix}-*",
      "arn:aws:rds:us-east-2:${local.account_id}:subgrp:${local.name_prefix}-*",
      "arn:aws:rds:us-east-2:${local.account_id}:og:*",
      "arn:aws:rds:us-east-2:${local.account_id}:pg:*",
    ]
  }

  # Terraform manages the service roles, so it needs to create and modify them.
  # Scoped to the group prefix to stay inside the permission boundary.
  statement {
    sid    = "GroupScopedIAM"
    effect = "Allow"
    actions = [
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:GetRole",
      "iam:UpdateRole",
      # iam:UpdateRole covers description/max-session-duration only — a
      # distinct action, iam:UpdateAssumeRolePolicy, is required to change a
      # role's trust policy. First surfaced 2026-09-20 when adding
      # release-web.yml to github_actions_deploy's job_workflow_ref allow-list
      # failed apply: every prior GroupScopedIAM change had only ever touched
      # an inline policy or a brand-new role, never an existing role's trust
      # relationship.
      "iam:UpdateAssumeRolePolicy",
      "iam:PassRole",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:ListRoleTags",
      "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:GetRolePolicy",
      "iam:ListRolePolicies",
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
      "iam:ListAttachedRolePolicies",
    ]
    resources = ["arn:aws:iam::${local.account_id}:role/${local.name_prefix}-*"]
  }

  statement {
    sid    = "ReadManagedPoliciesAndOIDC"
    effect = "Allow"
    actions = [
      "iam:GetPolicy",
      "iam:GetPolicyVersion",
      "iam:ListPolicyVersions",
      "iam:ListOpenIDConnectProviders",
      "iam:GetOpenIDConnectProvider",
    ]
    resources = ["*"]
  }

  # Enumerated rather than s3:*, which the IaC scan flags as AVD-AWS-0345. The
  # resource scope already confines this to devops-g2-* buckets, but s3:* there
  # still includes PutBucketPolicy and PutBucketAcl — enough to make one of our
  # own buckets public. These are the actions the aws_s3_bucket resources in
  # infra/ actually need.
  statement {
    sid    = "GroupScopedBuckets"
    effect = "Allow"
    actions = [
      "s3:CreateBucket",
      "s3:DeleteBucket",
      "s3:ListBucket",
      "s3:GetBucketLocation",
      "s3:GetBucketAcl",
      "s3:GetBucketPolicy",
      "s3:GetBucketTagging",
      "s3:PutBucketTagging",
      "s3:GetBucketVersioning",
      "s3:PutBucketVersioning",
      "s3:GetEncryptionConfiguration",
      "s3:PutEncryptionConfiguration",
      "s3:GetBucketPublicAccessBlock",
      "s3:PutBucketPublicAccessBlock",
      "s3:GetLifecycleConfiguration",
      "s3:PutLifecycleConfiguration",
      # The provider's aws_s3_bucket read/refresh checks every one of these
      # sub-configurations on a freshly created bucket, whether or not the
      # resource actually sets them. GetBucketAcl surfaced first (2026-09-21),
      # then GetBucketCORS immediately after on retry — added the rest of the
      # set up front rather than discovering each one on its own apply cycle.
      "s3:GetBucketCORS",
      "s3:GetBucketWebsite",
      "s3:GetBucketLogging",
      "s3:GetBucketObjectLockConfiguration",
      "s3:GetBucketRequestPayment",
      "s3:GetReplicationConfiguration",
      "s3:GetAccelerateConfiguration",
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
    ]
    resources = [
      "arn:aws:s3:::${local.name_prefix}-*",
      "arn:aws:s3:::${local.name_prefix}-*/*",
    ]
  }

  statement {
    sid    = "ReadForPlan"
    effect = "Allow"
    actions = [
      "kms:GetKeyPolicy",
      "kms:ListResourceTags",
      "dynamodb:DescribeTable",
      "dynamodb:ListTagsOfResource",
      "sts:GetCallerIdentity",
    ]
    resources = ["*"]
  }

  # Full lifecycle for aws_secretsmanager_secret.service_auth /
  # aws_secretsmanager_secret_version.service_auth, scoped to this group's
  # secret prefix so the apply role can't touch anyone else's secrets.
  statement {
    sid    = "ManageSecrets"
    effect = "Allow"
    actions = [
      "secretsmanager:CreateSecret",
      "secretsmanager:DescribeSecret",
      "secretsmanager:GetSecretValue",
      "secretsmanager:PutSecretValue",
      "secretsmanager:UpdateSecret",
      "secretsmanager:DeleteSecret",
      "secretsmanager:TagResource",
      "secretsmanager:UntagResource",
      "secretsmanager:ListSecretVersionIds",
      "secretsmanager:GetResourcePolicy",
    ]
    resources = ["arn:aws:secretsmanager:us-east-2:${local.account_id}:secret:${local.name_prefix}/*"]
  }

  # The cache. Resource-scopable actions are scoped; the Describe* calls
  # Terraform makes on every refresh are not — ElastiCache's describe APIs
  # return account-wide collections and have no resource dimension.
  statement {
    sid    = "ManageCache"
    effect = "Allow"
    actions = [
      "elasticache:Create*",
      "elasticache:Delete*",
      "elasticache:Modify*",
      "elasticache:AddTagsToResource",
      "elasticache:RemoveTagsFromResource",
      "elasticache:ListTagsForResource",
    ]
    resources = [
      "arn:aws:elasticache:us-east-2:${local.account_id}:replicationgroup:${local.name_prefix}-*",
      "arn:aws:elasticache:us-east-2:${local.account_id}:subnetgroup:${local.name_prefix}-*",
      "arn:aws:elasticache:us-east-2:${local.account_id}:parametergroup:${local.name_prefix}-*",
    ]
  }

  statement {
    sid       = "ReadCacheForPlan"
    effect    = "Allow"
    actions   = ["elasticache:Describe*"]
    resources = ["*"]
  }

  # SQS supports resource-level permissions on every action Terraform needs
  # here, so this one is fully scoped to the group prefix — no account-wide
  # companion statement required.
  statement {
    sid    = "ManageQueues"
    effect = "Allow"
    actions = [
      "sqs:CreateQueue",
      "sqs:DeleteQueue",
      "sqs:GetQueueAttributes",
      "sqs:SetQueueAttributes",
      "sqs:GetQueueUrl",
      "sqs:ListQueueTags",
      "sqs:TagQueue",
      "sqs:UntagQueue",
    ]
    resources = ["arn:aws:sqs:us-east-2:${local.account_id}:${local.name_prefix}-*"]
  }
}

resource "aws_iam_role_policy" "github_actions_apply" {
  name   = "${local.name_prefix}-ci-apply-policy"
  role   = aws_iam_role.github_actions_apply.id
  policy = data.aws_iam_policy_document.github_apply_permissions.json
}

output "github_actions_apply_role_arn" {
  value = aws_iam_role.github_actions_apply.arn
}
