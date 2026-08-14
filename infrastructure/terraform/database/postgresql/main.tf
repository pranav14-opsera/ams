locals {
  common_tags = {
    Project     = var.name_prefix
    Environment = var.environment
    ManagedBy   = "terraform"
    Module      = "database-postgresql"
  }

  identifier = "${var.name_prefix}-${var.environment}-postgresql"
}

# --- Subnet group -----------------------------------------------------

resource "aws_db_subnet_group" "main" {
  name       = "${local.identifier}-subnets"
  subnet_ids = var.data_subnet_ids

  tags = local.common_tags
}

# --- Parameter group ----------------------------------------------------
# IMPORTANT: AWS RDS for PostgreSQL does not support the TimescaleDB
# extension (confirmed AWS limitation — TimescaleDB requires a self-managed
# EC2/container PostgreSQL instance or Timescale Cloud; Aurora PostgreSQL
# doesn't support it either). This parameter group therefore does NOT set
# shared_preload_libraries = 'timescaledb'. See migrations/007_*.sql for how
# the agent_metrics time-series/continuous-aggregate requirement is
# implemented instead, using native PostgreSQL declarative partitioning +
# materialized views. If genuine TimescaleDB compression/hypertable
# features become a hard requirement, that table needs to move to a
# separate self-managed Postgres instance — a decision for the platform
# team, out of scope for this module.
resource "aws_db_parameter_group" "main" {
  name_prefix = "${local.identifier}-"
  family      = "postgres16"
  description = "Parameter group for ${local.identifier}"

  parameter {
    name  = "log_connections"
    value = "1"
  }

  parameter {
    name  = "log_disconnections"
    value = "1"
  }

  parameter {
    name  = "log_statement"
    value = "ddl"
  }

  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }

  tags = local.common_tags

  lifecycle {
    create_before_destroy = true
  }
}

# --- Enhanced monitoring role (created only if the caller didn't pass one) --

data "aws_iam_policy_document" "monitoring_assume" {
  count = var.monitoring_role_arn == null ? 1 : 0

  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["monitoring.rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "monitoring" {
  count = var.monitoring_role_arn == null ? 1 : 0

  name               = "${local.identifier}-monitoring"
  assume_role_policy = data.aws_iam_policy_document.monitoring_assume[0].json

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "monitoring" {
  count = var.monitoring_role_arn == null ? 1 : 0

  role       = aws_iam_role.monitoring[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

# --- RDS instance ---------------------------------------------------------
# Master password: not a Terraform variable. `manage_master_user_password`
# delegates password generation and storage to a Secrets Manager secret
# that RDS itself creates and rotates — it never appears in Terraform state
# or the .tf files, addressing the reasonable objection to hand-generating
# a DB password.

resource "aws_db_instance" "main" {
  identifier     = local.identifier
  engine         = "postgres"
  engine_version = var.engine_version
  instance_class = var.instance_class

  allocated_storage     = var.allocated_storage_gb
  max_allocated_storage = var.max_allocated_storage_gb
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = var.platform_kms_key_arn

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [var.data_zone_security_group_id]
  parameter_group_name   = aws_db_parameter_group.main.name

  multi_az = true

  username                      = var.master_username
  manage_master_user_password   = true
  master_user_secret_kms_key_id = var.platform_kms_key_arn
  # In addition to the Secrets-Manager-managed master password above, allow
  # IAM-authenticated connections too — lets application/tooling roles
  # connect with short-lived STS tokens instead of ever handling the master
  # secret themselves.
  iam_database_authentication_enabled = true

  backup_retention_period = var.backup_retention_days
  backup_window           = "03:00-04:00"
  maintenance_window      = "mon:04:30-mon:05:30"
  copy_tags_to_snapshot   = true

  # Point-in-time recovery is continuous WAL archiving under the hood —
  # RPO is a few minutes, well within the 1-hour requirement — as long as
  # backup_retention_period > 0, which it is (35 days).
  #
  # Deletion protection is unconditional, including for dev/staging: this
  # holds tenant PHI-adjacent data from the first environment it's deployed
  # to, and an accidental `terraform destroy` is exactly the kind of
  # mistake this exists to add friction against. Tearing down a lower
  # environment on purpose is a deliberate two-step process (disable
  # protection, then destroy) rather than a single command — that's the
  # intended trade-off, not an oversight.
  deletion_protection       = true
  skip_final_snapshot       = var.environment != "prod"
  final_snapshot_identifier = var.environment == "prod" ? "${local.identifier}-final" : null

  performance_insights_enabled          = true
  performance_insights_kms_key_id       = var.platform_kms_key_arn
  performance_insights_retention_period = 7

  monitoring_interval = 60
  monitoring_role_arn = coalesce(var.monitoring_role_arn, try(aws_iam_role.monitoring[0].arn, null))

  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  auto_minor_version_upgrade = true

  tags = merge(local.common_tags, {
    Name = local.identifier
  })
}
