locals {
  common_tags = {
    Project     = var.name_prefix
    Environment = var.environment
    ManagedBy   = "terraform"
    Module      = "kms"
  }
}

data "aws_caller_identity" "current" {}

# --- Platform symmetric key (AES-256, application data at rest) -----------
# Separation of duty (acceptance criteria): application_role_arns can
# encrypt/decrypt but cannot touch the key policy, grants, or rotation
# config. Only platform_admin_role_arns get kms:PutKeyPolicy / kms:*Grant /
# key administration. The account root gets the usual full-access
# statement so the account is never locked out of a key it owns.
#checkov:skip=CKV_AWS_109:resources="*" is required key-policy syntax, not an unconstrained identity-policy grant
#checkov:skip=CKV_AWS_111:resources="*" is required key-policy syntax, not an unconstrained identity-policy grant
#checkov:skip=CKV_AWS_356:resources="*" is required key-policy syntax, not an unconstrained identity-policy grant
data "aws_iam_policy_document" "platform_key" {
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

  dynamic "statement" {
    for_each = length(var.platform_admin_role_arns) > 0 ? [1] : []
    content {
      sid    = "PlatformAdminKeyManagement"
      effect = "Allow"
      actions = [
        "kms:PutKeyPolicy",
        "kms:CreateGrant",
        "kms:RevokeGrant",
        "kms:ListGrants",
        "kms:EnableKeyRotation",
        "kms:DisableKeyRotation",
        "kms:GetKeyRotationStatus",
        "kms:TagResource",
        "kms:UntagResource",
      ]
      resources = ["*"]

      principals {
        type        = "AWS"
        identifiers = var.platform_admin_role_arns
      }
    }
  }

  dynamic "statement" {
    for_each = length(var.application_role_arns) > 0 ? [1] : []
    content {
      sid    = "ApplicationEncryptDecryptOnly"
      effect = "Allow"
      actions = [
        "kms:Encrypt",
        "kms:Decrypt",
        "kms:ReEncrypt*",
        "kms:GenerateDataKey*",
        "kms:DescribeKey",
      ]
      resources = ["*"]

      principals {
        type        = "AWS"
        identifiers = var.application_role_arns
      }
    }
  }
}

resource "aws_kms_key" "platform" {
  description              = "${var.name_prefix}-${var.environment} platform key — AES-256 encryption for application data at rest"
  key_usage                = "ENCRYPT_DECRYPT"
  customer_master_key_spec = "SYMMETRIC_DEFAULT"
  deletion_window_in_days  = 30
  enable_key_rotation      = true
  rotation_period_in_days  = var.platform_key_rotation_days
  policy                   = data.aws_iam_policy_document.platform_key.json

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-${var.environment}-platform-key"
  })
}

resource "aws_kms_alias" "platform" {
  name          = "alias/${var.name_prefix}-${var.environment}-platform"
  target_key_id = aws_kms_key.platform.key_id
}
