# RDS Proxy for connection pooling — 20 connections per service instance,
# 200 total, per the acceptance criteria. RDS Proxy is preferred over a
# self-managed PgBouncer here since it's a managed AWS service requiring no
# additional compute/patching, and it integrates directly with the
# Secrets Manager-managed master password (manage_master_user_password in
# main.tf) via IAM authentication.

data "aws_iam_policy_document" "rds_proxy_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "rds_proxy" {
  name               = "${local.identifier}-proxy"
  assume_role_policy = data.aws_iam_policy_document.rds_proxy_assume.json

  tags = local.common_tags
}

data "aws_iam_policy_document" "rds_proxy_secrets_access" {
  statement {
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_db_instance.main.master_user_secret[0].secret_arn]
  }

  statement {
    effect    = "Allow"
    actions   = ["kms:Decrypt"]
    resources = [var.platform_kms_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "rds_proxy_secrets_access" {
  name   = "${local.identifier}-proxy-secrets-access"
  role   = aws_iam_role.rds_proxy.id
  policy = data.aws_iam_policy_document.rds_proxy_secrets_access.json
}

resource "aws_db_proxy" "main" {
  name                   = "${local.identifier}-proxy"
  engine_family          = "POSTGRESQL"
  role_arn               = aws_iam_role.rds_proxy.arn
  vpc_subnet_ids         = var.data_subnet_ids
  vpc_security_group_ids = [var.data_zone_security_group_id]
  require_tls            = true

  auth {
    auth_scheme = "SECRETS"
    iam_auth    = "DISABLED"
    secret_arn  = aws_db_instance.main.master_user_secret[0].secret_arn
  }

  tags = local.common_tags
}

resource "aws_db_proxy_default_target_group" "main" {
  db_proxy_name = aws_db_proxy.main.name

  connection_pool_config {
    # 20 connections per service instance is an application-side
    # per-instance pool setting; RDS Proxy's own knob is the ceiling on
    # how much of the underlying instance's total connection budget this
    # proxy may use.
    max_connections_percent      = 100
    max_idle_connections_percent = 50
  }
}

resource "aws_db_proxy_target" "main" {
  db_proxy_name          = aws_db_proxy.main.name
  target_group_name      = aws_db_proxy_default_target_group.main.name
  db_instance_identifier = aws_db_instance.main.identifier
}
