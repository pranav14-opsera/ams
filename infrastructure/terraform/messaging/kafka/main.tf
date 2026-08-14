locals {
  common_tags = {
    Project     = var.name_prefix
    Environment = var.environment
    ManagedBy   = "terraform"
    Module      = "messaging-kafka"
  }

  identifier     = "${var.name_prefix}-${var.environment}-kafka"
  scram_username = "${var.name_prefix}_app"
}

data "aws_subnet" "first_data_subnet" {
  id = var.data_subnet_ids[0]
}

# --- SASL/SCRAM credentials ------------------------------------------------
# Mirrors cache/redis's pattern: the secrets module (WO-003) already owns a
# "kafka-sasl-credentials" entry in its managed_secrets map with 90-day
# rotation via its shared Lambda. This module generates the initial
# password and writes it into that EXISTING secret (var.kafka_secret_id)
# rather than creating a second, colliding one — the redis module's first
# draft got this wrong and was fixed in WO-005; not repeating that mistake
# here.

resource "random_password" "scram_password" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret_version" "kafka_sasl" {
  secret_id = var.kafka_secret_id
  secret_string = jsonencode({
    secret_type       = "kafka_scram"
    bootstrap_servers = aws_msk_cluster.main.bootstrap_brokers_sasl_scram
    username          = local.scram_username
    password          = random_password.scram_password.result
  })

  lifecycle {
    ignore_changes = [secret_string] # the secrets module's rotation Lambda owns updates after the first apply
  }
}

# MSK requires the SASL/SCRAM secret to ALSO be a native Secrets Manager
# secret tagged for MSK's own association mechanism — separate from (and in
# addition to) the app-facing secret above, because
# aws_msk_scram_secret_association only accepts secrets it manages this way
# and MSK requires the secret name to start with "AmazonMSK_".
#
# KNOWN LIMITATION, not silently ignored: this secret has no automatic
# rotation. The secrets module's shared rotation Lambda (WO-003) dispatches
# by secret_type and doesn't know how to call MSK's scram-secret-association
# API to keep this MSK-specific secret in sync with a rotated credential —
# building that is real follow-up work, out of scope for provisioning the
# cluster itself. Until then, rotating var.kafka_secret_id's password
# without also updating this secret would desync the two and break SASL
# auth; this must be a manual, coordinated operation for now.
resource "aws_secretsmanager_secret" "msk_scram" {
  name       = "AmazonMSK_${local.identifier}"
  kms_key_id = var.platform_kms_key_arn

  tags = merge(local.common_tags, {
    Name = "${local.identifier}-msk-scram"
  })
}

resource "aws_secretsmanager_secret_version" "msk_scram" {
  secret_id = aws_secretsmanager_secret.msk_scram.id
  secret_string = jsonencode({
    username = local.scram_username
    password = random_password.scram_password.result
  })
}

resource "aws_msk_scram_secret_association" "main" {
  cluster_arn     = aws_msk_cluster.main.arn
  secret_arn_list = [aws_secretsmanager_secret.msk_scram.arn]

  depends_on = [aws_secretsmanager_secret_version.msk_scram]
}

# --- Security group -------------------------------------------------------

resource "aws_security_group" "kafka" {
  name_prefix = "${local.identifier}-"
  description = "Kafka: only the internal-zone security group may connect"
  vpc_id      = data.aws_subnet.first_data_subnet.vpc_id

  tags = merge(local.common_tags, {
    Name = "${local.identifier}-sg"
  })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_security_group_rule" "kafka_ingress_tls" {
  type                     = "ingress"
  from_port                = 9094
  to_port                  = 9094
  protocol                 = "tcp"
  source_security_group_id = var.internal_zone_security_group_id
  security_group_id        = aws_security_group.kafka.id
  description              = "TLS client communication"
}

resource "aws_security_group_rule" "kafka_ingress_sasl" {
  type                     = "ingress"
  from_port                = 9096
  to_port                  = 9096
  protocol                 = "tcp"
  source_security_group_id = var.internal_zone_security_group_id
  security_group_id        = aws_security_group.kafka.id
  description              = "SASL/SCRAM client communication"
}

resource "aws_security_group_rule" "kafka_egress_within_data_zone" {
  type              = "egress"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = [data.aws_subnet.first_data_subnet.cidr_block]
  security_group_id = aws_security_group.kafka.id
  description       = "Inter-broker replication traffic within the data zone"
}

# --- CloudWatch log group for broker logs ---------------------------------

resource "aws_cloudwatch_log_group" "broker_logs" {
  name              = "/aws/msk/${local.identifier}"
  retention_in_days = 365
  kms_key_id        = var.platform_kms_key_arn

  tags = local.common_tags
}

# --- MSK cluster -----------------------------------------------------------

resource "aws_msk_configuration" "main" {
  name              = "${local.identifier}-config"
  kafka_versions    = [var.kafka_version]
  server_properties = <<-PROPERTIES
    auto.create.topics.enable=false
    default.replication.factor=3
    min.insync.replicas=2
    num.partitions=6
    unclean.leader.election.enable=false
  PROPERTIES
}

resource "aws_msk_cluster" "main" {
  cluster_name           = local.identifier
  kafka_version          = var.kafka_version
  number_of_broker_nodes = 3 # one per AZ in data_subnet_ids, matching the 3x replication requirement

  broker_node_group_info {
    instance_type   = var.broker_instance_type
    client_subnets  = var.data_subnet_ids
    security_groups = [aws_security_group.kafka.id]

    storage_info {
      ebs_storage_info {
        volume_size = var.broker_storage_gb
      }
    }
  }

  configuration_info {
    arn      = aws_msk_configuration.main.arn
    revision = aws_msk_configuration.main.latest_revision
  }

  encryption_info {
    encryption_at_rest_kms_key_arn = var.platform_kms_key_arn

    encryption_in_transit {
      client_broker = "TLS"
      in_cluster    = true
    }
  }

  client_authentication {
    sasl {
      scram = true
    }
  }

  logging_info {
    broker_logs {
      cloudwatch_logs {
        enabled   = true
        log_group = aws_cloudwatch_log_group.broker_logs.name
      }
    }
  }

  enhanced_monitoring = "PER_TOPIC_PER_PARTITION"

  tags = merge(local.common_tags, {
    Name = local.identifier
  })
}
