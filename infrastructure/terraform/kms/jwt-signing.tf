# JWT signing key rotation. AWS KMS does not support automatic rotation for
# asymmetric keys (only symmetric keys support the built-in
# enable_key_rotation flag) — so a scheduled Lambda performs the rotation
# itself: it creates a brand-new RSA key generation, points the "current"
# alias at it, and points "previous" at the outgoing key so tokens signed
# under the old key still verify for jwt_key_overlap_days before the old
# key is scheduled for deletion.
#
# Terraform provisions generation 1 (the key that exists at `terraform
# apply` time) and the rotation infrastructure around it. Generations 2+ are
# created by the Lambda outside Terraform state, by design — that's what a
# rotation function does. `terraform plan` will not show drift for this: the
# aliases are Terraform-managed resources whose target the Lambda updates
# via the AWS API, which Terraform will refresh to match on the next plan
# (a data-plane change to a Terraform-owned resource, same pattern as an
# ASG's desired_size after the cluster autoscaler adjusts it in WO-001).

# Explicit key policy (rather than AWS's default, which only grants the
# account root): the rotation Lambda's role gets sign-key-lifecycle
# management, and application roles get GetPublicKey + Verify only — they
# consume tokens, they don't mint or destroy signing key generations.
data "aws_iam_policy_document" "jwt_signing_key" {
  statement {
    sid       = "AccountRootFullAccess"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  statement {
    sid    = "RotationLambdaManagesGenerations"
    effect = "Allow"
    actions = [
      "kms:DescribeKey",
      "kms:GetPublicKey",
      "kms:TagResource",
      "kms:ScheduleKeyDeletion",
    ]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = [aws_iam_role.jwt_rotation_lambda.arn]
    }
  }

  dynamic "statement" {
    for_each = length(var.application_role_arns) > 0 ? [1] : []
    content {
      sid       = "ApplicationSignAndVerify"
      effect    = "Allow"
      actions   = ["kms:Sign", "kms:Verify", "kms:GetPublicKey", "kms:DescribeKey"]
      resources = ["*"]

      principals {
        type        = "AWS"
        identifiers = var.application_role_arns
      }
    }
  }
}

resource "aws_kms_key" "jwt_signing" {
  description              = "${var.name_prefix}-${var.environment} JWT signing key (generation 1) — rotated by jwt-signing-rotation Lambda"
  key_usage                = "SIGN_VERIFY"
  customer_master_key_spec = var.jwt_signing_key_spec
  deletion_window_in_days  = 30
  policy                   = data.aws_iam_policy_document.jwt_signing_key.json

  tags = merge(local.common_tags, {
    Name       = "${var.name_prefix}-${var.environment}-jwt-signing-gen1"
    Generation = "1"
  })
}

resource "aws_kms_alias" "jwt_signing_current" {
  name          = "alias/${var.name_prefix}-${var.environment}-jwt-signing-current"
  target_key_id = aws_kms_key.jwt_signing.key_id

  lifecycle {
    # The rotation Lambda repoints this alias to each new generation; don't
    # fight it back to generation 1 on every terraform apply.
    ignore_changes = [target_key_id]
  }
}

resource "aws_kms_alias" "jwt_signing_previous" {
  name = "alias/${var.name_prefix}-${var.environment}-jwt-signing-previous"
  # At bootstrap there is no previous generation yet, so "previous" starts
  # out pointing at the same generation-1 key as "current". The first
  # rotation is what gives it a genuinely distinct target.
  target_key_id = aws_kms_key.jwt_signing.key_id

  lifecycle {
    ignore_changes = [target_key_id]
  }
}

# --- Rotation Lambda ---------------------------------------------------

data "archive_file" "jwt_rotation_lambda" {
  type        = "zip"
  source_dir  = "${path.module}/rotation-lambda"
  output_path = "${path.module}/rotation-lambda.zip"
  excludes    = ["tests", "__pycache__", "*.pyc"]
}

data "aws_iam_policy_document" "jwt_rotation_lambda_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "jwt_rotation_lambda" {
  name               = "${var.name_prefix}-${var.environment}-jwt-rotation-lambda"
  assume_role_policy = data.aws_iam_policy_document.jwt_rotation_lambda_assume.json

  tags = local.common_tags
}

data "aws_iam_policy_document" "jwt_rotation_lambda_permissions" {
  statement {
    sid       = "ManageJwtSigningAliases"
    effect    = "Allow"
    actions   = ["kms:CreateAlias", "kms:UpdateAlias", "kms:DeleteAlias"]
    resources = ["arn:aws:kms:${var.region}:${data.aws_caller_identity.current.account_id}:alias/${var.name_prefix}-${var.environment}-jwt-signing-*"]
  }

  # kms:CreateKey has no resource to scope to (the key doesn't exist until
  # the call succeeds — AWS requires resources=["*"] for it). DescribeKey /
  # ListAliases / GetPublicKey / TagResource / ScheduleKeyDeletion target
  # whichever key generation the Lambda just created or is retiring, whose
  # key ID isn't known ahead of time either, so they share the same
  # constraint.
  statement {
    sid    = "ManageJwtSigningKeyGenerations"
    effect = "Allow"
    actions = [
      "kms:CreateKey",
      "kms:ScheduleKeyDeletion",
      "kms:DescribeKey",
      "kms:ListAliases",
      "kms:TagResource",
      "kms:GetPublicKey",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "WriteOwnLogs"
    effect    = "Allow"
    actions   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/lambda/${var.name_prefix}-${var.environment}-jwt-rotation:*"]
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
    resources = [aws_sqs_queue.jwt_rotation_dlq.arn]
  }
}

resource "aws_sqs_queue" "jwt_rotation_dlq" {
  name              = "${var.name_prefix}-${var.environment}-jwt-rotation-dlq"
  kms_master_key_id = aws_kms_key.platform.arn
  # Long enough to investigate and manually retry a failed rotation before
  # the message is lost — a rotation failure is a same-day operational
  # concern, not a multi-week one.
  message_retention_seconds = 1209600 # 14 days

  tags = local.common_tags
}

resource "aws_iam_role_policy" "jwt_rotation_lambda" {
  name   = "${var.name_prefix}-${var.environment}-jwt-rotation-permissions"
  role   = aws_iam_role.jwt_rotation_lambda.id
  policy = data.aws_iam_policy_document.jwt_rotation_lambda_permissions.json
}

resource "aws_cloudwatch_log_group" "jwt_rotation_lambda" {
  name              = "/aws/lambda/${var.name_prefix}-${var.environment}-jwt-rotation"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.platform.arn

  tags = local.common_tags
}

# This function calls only the public KMS API (CreateKey/UpdateAlias/etc.)
# — it never reaches anything inside the VPC. Placing it in the VPC would
# add NAT egress cost/latency for zero isolation benefit (it would still
# need to reach the internet or a KMS VPC endpoint to call the same public
# AWS API), so it deliberately runs outside the VPC.
#checkov:skip=CKV_AWS_117:this function only calls the public KMS API, never a VPC resource — VPC placement would add NAT cost for no isolation benefit
resource "aws_lambda_function" "jwt_rotation" {
  function_name    = "${var.name_prefix}-${var.environment}-jwt-rotation"
  role             = aws_iam_role.jwt_rotation_lambda.arn
  handler          = "handler.lambda_handler"
  runtime          = "python3.12"
  timeout          = 60
  memory_size      = 128
  filename         = data.archive_file.jwt_rotation_lambda.output_path
  source_code_hash = data.archive_file.jwt_rotation_lambda.output_base64sha256
  kms_key_arn      = aws_kms_key.platform.arn
  # Rotation must never run concurrently with itself — two overlapping runs
  # racing to create generation N+1 would corrupt the current/previous
  # alias bookkeeping. 1 keeps it single-flight without blocking other
  # functions' concurrency pool.
  reserved_concurrent_executions = 1

  environment {
    variables = {
      CURRENT_ALIAS_NAME  = aws_kms_alias.jwt_signing_current.name
      PREVIOUS_ALIAS_NAME = aws_kms_alias.jwt_signing_previous.name
      KEY_SPEC            = var.jwt_signing_key_spec
      OVERLAP_DAYS        = tostring(var.jwt_key_overlap_days)
      NAME_PREFIX         = var.name_prefix
      ENVIRONMENT         = var.environment
    }
  }

  dead_letter_config {
    target_arn = aws_sqs_queue.jwt_rotation_dlq.arn
  }

  tracing_config {
    mode = "Active"
  }

  tags = local.common_tags

  depends_on = [aws_cloudwatch_log_group.jwt_rotation_lambda]
}

resource "aws_cloudwatch_event_rule" "jwt_rotation_schedule" {
  name                = "${var.name_prefix}-${var.environment}-jwt-rotation-schedule"
  description         = "Triggers JWT signing key rotation on the configured schedule"
  schedule_expression = var.jwt_rotation_schedule_expression

  tags = local.common_tags
}

resource "aws_cloudwatch_event_target" "jwt_rotation" {
  rule = aws_cloudwatch_event_rule.jwt_rotation_schedule.name
  arn  = aws_lambda_function.jwt_rotation.arn
}

resource "aws_lambda_permission" "allow_eventbridge_jwt_rotation" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.jwt_rotation.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.jwt_rotation_schedule.arn
}
