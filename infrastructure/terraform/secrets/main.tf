locals {
  common_tags = {
    Project     = var.name_prefix
    Environment = var.environment
    ManagedBy   = "terraform"
    Module      = "secrets"
  }
}

data "aws_caller_identity" "current" {}

# --- Rotation Lambda (shared across all managed secrets) ------------------
# One Lambda, dispatching on SecretsManager's `SecretId` (matched against
# `managed_secrets` by name) to decide which credential-rotation strategy to
# run. Runs inside the VPC's private subnets so it can reach the database/
# cache/broker directly to test and apply new credentials.

data "archive_file" "secret_rotation_lambda" {
  type        = "zip"
  source_dir  = "${path.module}/rotation-lambda"
  output_path = "${path.module}/rotation-lambda.zip"
  excludes    = ["tests", "__pycache__", "*.pyc"]
}

data "aws_iam_policy_document" "secret_rotation_lambda_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "secret_rotation_lambda" {
  name               = "${var.name_prefix}-${var.environment}-secret-rotation-lambda"
  assume_role_policy = data.aws_iam_policy_document.secret_rotation_lambda_assume.json

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "secret_rotation_lambda_vpc" {
  role       = aws_iam_role.secret_rotation_lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

data "aws_iam_policy_document" "secret_rotation_lambda_permissions" {
  statement {
    sid    = "ManageOwnSecretVersions"
    effect = "Allow"
    actions = [
      "secretsmanager:DescribeSecret",
      "secretsmanager:GetSecretValue",
      "secretsmanager:PutSecretValue",
      "secretsmanager:UpdateSecretVersionStage",
    ]
    resources = [for s in aws_secretsmanager_secret.managed : s.arn]
  }

  statement {
    sid       = "GenerateRandomCredentials"
    effect    = "Allow"
    actions   = ["secretsmanager:GetRandomPassword"]
    resources = ["*"]
  }

  statement {
    sid       = "DecryptSecretsWithPlatformKey"
    effect    = "Allow"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey"]
    resources = [var.platform_kms_key_arn]
  }

  statement {
    sid       = "XRayTracing"
    effect    = "Allow"
    actions   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords"]
    resources = ["*"]
  }

  statement {
    sid       = "SendToDeadLetterQueue"
    effect    = "Allow"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.secret_rotation_dlq.arn]
  }
}

resource "aws_sqs_queue" "secret_rotation_dlq" {
  name                      = "${var.name_prefix}-${var.environment}-secret-rotation-dlq"
  kms_master_key_id         = var.platform_kms_key_arn
  message_retention_seconds = 1209600 # 14 days

  tags = local.common_tags
}

resource "aws_iam_role_policy" "secret_rotation_lambda" {
  name   = "${var.name_prefix}-${var.environment}-secret-rotation-permissions"
  role   = aws_iam_role.secret_rotation_lambda.id
  policy = data.aws_iam_policy_document.secret_rotation_lambda_permissions.json
}

resource "aws_security_group" "secret_rotation_lambda" {
  name_prefix = "${var.name_prefix}-${var.environment}-secret-rotation-"
  description = "Rotation Lambda: outbound only, to reach the database/cache/broker being rotated"
  vpc_id      = var.vpc_id

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-${var.environment}-sg-secret-rotation"
  })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group_rule" "secret_rotation_lambda_egress_vpc" {
  type              = "egress"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = [var.vpc_cidr]
  security_group_id = aws_security_group.secret_rotation_lambda.id
  description       = "Reach the database/cache/broker being rotated, all within the VPC"
}

resource "aws_security_group_rule" "secret_rotation_lambda_egress_aws_api" {
  type              = "egress"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.secret_rotation_lambda.id
  description       = "HTTPS to Secrets Manager/KMS public API endpoints (no VPC endpoint provisioned for these in this module)"
}

resource "aws_cloudwatch_log_group" "secret_rotation_lambda" {
  name              = "/aws/lambda/${var.name_prefix}-${var.environment}-secret-rotation"
  retention_in_days = 365
  kms_key_id        = var.platform_kms_key_arn

  tags = local.common_tags
}

resource "aws_lambda_function" "secret_rotation" {
  function_name    = "${var.name_prefix}-${var.environment}-secret-rotation"
  role             = aws_iam_role.secret_rotation_lambda.arn
  handler          = "handler.lambda_handler"
  runtime          = "python3.12"
  timeout          = 60
  memory_size      = 256
  filename         = data.archive_file.secret_rotation_lambda.output_path
  source_code_hash = data.archive_file.secret_rotation_lambda.output_base64sha256
  kms_key_arn      = var.platform_kms_key_arn
  # Rotating one secret at a time avoids two concurrent rotations racing to
  # write conflicting AWSPENDING versions against the same target service.
  reserved_concurrent_executions = 5

  environment {
    variables = {
      LOG_LEVEL = "INFO"
    }
  }

  vpc_config {
    subnet_ids         = var.private_subnet_ids
    security_group_ids = concat([aws_security_group.secret_rotation_lambda.id], var.rotation_lambda_security_group_ids)
  }

  dead_letter_config {
    target_arn = aws_sqs_queue.secret_rotation_dlq.arn
  }

  tracing_config {
    mode = "Active"
  }

  tags = local.common_tags

  depends_on = [
    aws_cloudwatch_log_group.secret_rotation_lambda,
    aws_iam_role_policy_attachment.secret_rotation_lambda_vpc,
  ]
}

# Confused-deputy protection: Secrets Manager can only invoke this function
# on behalf of this account. A single Lambda serves all secrets in
# managed_secrets, so unlike a single-secret setup this can't be scoped
# further to one secret's source_arn — source_account is AWS's documented
# mitigation for exactly this multi-resource case.
# nosemgrep: terraform.aws.security.aws-lambda-permission-unrestricted-source-arn.aws-lambda-permission-unrestricted-source-arn
resource "aws_lambda_permission" "allow_secretsmanager" {
  statement_id   = "AllowSecretsManagerInvoke"
  action         = "lambda:InvokeFunction"
  function_name  = aws_lambda_function.secret_rotation.function_name
  principal      = "secretsmanager.amazonaws.com"
  source_account = data.aws_caller_identity.current.account_id
}

# --- Managed secrets ---------------------------------------------------

resource "aws_secretsmanager_secret" "managed" {
  for_each = var.managed_secrets

  name        = "${var.name_prefix}/${var.environment}/${each.key}"
  description = each.value.description
  kms_key_id  = var.platform_kms_key_arn

  tags = merge(local.common_tags, {
    Name       = "${var.name_prefix}-${var.environment}-${each.key}"
    SecretType = each.value.secret_type
  })
}

resource "aws_secretsmanager_secret_rotation" "managed" {
  for_each = var.managed_secrets

  secret_id           = aws_secretsmanager_secret.managed[each.key].id
  rotation_lambda_arn = aws_lambda_function.secret_rotation.arn

  rotation_rules {
    automatically_after_days = var.rotation_days
  }

  depends_on = [aws_lambda_permission.allow_secretsmanager]
}

# --- Separation of duty ---------------------------------------------------
# Application roles: GetSecretValue only, on the specific secrets they need.
# Platform admins: full secret lifecycle + rotation configuration.
data "aws_iam_policy_document" "secret_resource_policy" {
  for_each = var.managed_secrets

  dynamic "statement" {
    for_each = length(var.application_role_arns) > 0 ? [1] : []
    content {
      sid       = "ApplicationReadOnly"
      effect    = "Allow"
      actions   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
      resources = ["*"]

      principals {
        type        = "AWS"
        identifiers = var.application_role_arns
      }
    }
  }

  dynamic "statement" {
    for_each = length(var.platform_admin_role_arns) > 0 ? [1] : []
    content {
      sid    = "PlatformAdminFullAccess"
      effect = "Allow"
      actions = [
        "secretsmanager:*",
      ]
      resources = ["*"]

      principals {
        type        = "AWS"
        identifiers = var.platform_admin_role_arns
      }
    }
  }
}

resource "aws_secretsmanager_secret_policy" "managed" {
  for_each = {
    for k, v in var.managed_secrets : k => v
    if length(var.application_role_arns) > 0 || length(var.platform_admin_role_arns) > 0
  }

  secret_arn = aws_secretsmanager_secret.managed[each.key].arn
  policy     = data.aws_iam_policy_document.secret_resource_policy[each.key].json
}
