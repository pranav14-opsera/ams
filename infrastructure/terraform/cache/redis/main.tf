locals {
  common_tags = {
    Project     = var.name_prefix
    Environment = var.environment
    ManagedBy   = "terraform"
    Module      = "cache-redis"
  }

  identifier = "${var.name_prefix}-${var.environment}-redis"
}

# --- AUTH token ------------------------------------------------------
# The Secrets Manager secret itself is NOT created here: WO-003's
# infrastructure/terraform/secrets module already owns a "redis-auth-token"
# entry in its managed_secrets map (secret_type = "redis"), complete with
# 90-day automatic rotation via its shared rotation Lambda. Creating a
# second aws_secretsmanager_secret with the same name path from this module
# would collide with that one at apply time (Secrets Manager names must be
# unique) and split ownership of a single secret across two modules. This
# module only generates the initial auth token value and writes it into
# that EXISTING secret (passed in via var.redis_auth_secret_id) — the
# secrets module's rotation Lambda takes over updating it from then on.

resource "random_password" "auth_token" {
  length  = 64
  special = false # ElastiCache AUTH tokens reject some special characters; alphanumeric is both simpler and fully supported
}

resource "aws_secretsmanager_secret_version" "redis_auth" {
  secret_id = var.redis_auth_secret_id
  secret_string = jsonencode({
    secret_type = "redis"
    host        = aws_elasticache_replication_group.main.primary_endpoint_address
    port        = aws_elasticache_replication_group.main.port
    auth_token  = random_password.auth_token.result
  })

  lifecycle {
    # The secrets module's rotation Lambda owns updating auth_token after
    # the first rotation — Terraform should not fight it back to this
    # initial value on every apply.
    ignore_changes = [secret_string]
  }
}

# --- Networking -------------------------------------------------------

resource "aws_elasticache_subnet_group" "main" {
  name       = "${local.identifier}-subnets"
  subnet_ids = var.data_subnet_ids

  tags = local.common_tags
}

resource "aws_security_group" "redis" {
  name_prefix = "${local.identifier}-"
  description = "Redis: only the internal-zone security group may connect, on 6379"
  vpc_id      = data.aws_subnet.first_data_subnet.vpc_id

  tags = merge(local.common_tags, {
    Name = "${local.identifier}-sg"
  })

  lifecycle {
    create_before_destroy = true
  }
}

data "aws_subnet" "first_data_subnet" {
  id = var.data_subnet_ids[0]
}

resource "aws_security_group_rule" "redis_ingress_from_internal" {
  type                     = "ingress"
  from_port                = 6379
  to_port                  = 6379
  protocol                 = "tcp"
  source_security_group_id = var.internal_zone_security_group_id
  security_group_id        = aws_security_group.redis.id
  description              = "Redis from the internal zone only"
}

resource "aws_security_group_rule" "redis_egress_all" {
  type              = "egress"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = [data.aws_subnet.first_data_subnet.cidr_block]
  security_group_id = aws_security_group.redis.id
  description       = "Replication traffic within the data zone"
}

# --- Parameter group -----------------------------------------------------
# volatile-lru evicts only keys that carry an explicit TTL, which
# reconciles the acceptance criteria's two eviction requirements into one
# Redis-native mechanism rather than needing separate logical databases:
# cache keys (abac:*, credit:*, ws:*) are always written WITH a TTL and are
# eligible for LRU eviction under memory pressure; session keys are the
# application's responsibility to write WITHOUT a TTL (or with an
# explicit, long expiry tied to actual session lifetime) so they behave as
# effectively noeviction — volatile-lru never touches a key with no TTL
# set, regardless of memory pressure.
resource "aws_elasticache_parameter_group" "main" {
  # Unlike most AWS resources this module uses name_prefix for,
  # aws_elasticache_parameter_group has no name_prefix argument — only a
  # fixed, required "name". (Caught by CI's terraform validate, which
  # can't run locally in this environment — see README.)
  name        = "${local.identifier}-params"
  family      = "redis7"
  description = "Parameter group for ${local.identifier}"

  parameter {
    name  = "maxmemory-policy"
    value = "volatile-lru"
  }

  parameter {
    name  = "notify-keyspace-events"
    value = "Ex" # expired-key events, so services can react to session/cache expiry (e.g. WebSocket cleanup) rather than only polling
  }

  lifecycle {
    create_before_destroy = true
  }
}

# --- Replication group --------------------------------------------------
# NOTE on AOF: the work order asks for "AOF persistence with 1-second
# fsync". ElastiCache for Redis does not expose AOF as a configurable
# parameter — unlike self-managed Redis, it has no `appendonly`/
# `appendfsync` directive in any parameter group family. ElastiCache's own
# durability primitives are what this resource uses instead:
# automatic_failover_enabled + multi_az_enabled (RTO target: AWS's
# documented automatic failover typically completes in under a minute,
# comfortably inside the <5 minute acceptance criterion) and
# snapshot_retention_limit for point-in-time recovery via daily snapshots
# (RPO: up to 24h from snapshots alone, but combined with the multi-AZ
# replica's continuous replication, in-memory data survives any single-node
# failure without any snapshot restore being needed at all — snapshots are
# the fallback for a full cluster loss, not the normal failover path).
resource "aws_elasticache_replication_group" "main" {
  replication_group_id = local.identifier
  description          = "${local.identifier} — session/ABAC-cache/credit-cache/WebSocket-state store"

  engine         = "redis"
  engine_version = "7.1"
  node_type      = var.node_type
  port           = 6379

  num_cache_clusters = 2 # 1 primary + 1 replica, across the 2+ AZs in data_subnet_ids
  multi_az_enabled   = true

  automatic_failover_enabled = true

  subnet_group_name    = aws_elasticache_subnet_group.main.name
  security_group_ids   = [aws_security_group.redis.id]
  parameter_group_name = aws_elasticache_parameter_group.main.name

  transit_encryption_enabled = true
  auth_token                 = random_password.auth_token.result
  at_rest_encryption_enabled = true
  kms_key_id                 = var.platform_kms_key_arn

  snapshot_retention_limit = var.snapshot_retention_days
  snapshot_window          = "03:00-04:00"
  maintenance_window       = "mon:04:30-mon:05:30"

  auto_minor_version_upgrade = true
  apply_immediately          = var.environment != "prod"

  tags = merge(local.common_tags, {
    Name = local.identifier
  })
}
