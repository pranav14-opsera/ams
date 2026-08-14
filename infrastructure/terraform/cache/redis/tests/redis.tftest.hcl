mock_provider "aws" {}

override_data {
  target = data.aws_subnet.first_data_subnet
  values = {
    vpc_id     = "vpc-0123456789abcdef0"
    cidr_block = "10.0.96.0/20"
  }
}

variables {
  region                          = "us-east-1"
  environment                     = "dev"
  name_prefix                     = "ams"
  data_subnet_ids                 = ["subnet-data-a", "subnet-data-b", "subnet-data-c"]
  internal_zone_security_group_id = "sg-0123456789internal"
  platform_kms_key_arn            = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555"
  redis_auth_secret_id            = "arn:aws:secretsmanager:us-east-1:123456789012:secret:ams/dev/redis-auth-token-abc123"
}

run "replication_group_is_multi_az_encrypted" {
  command = apply

  assert {
    condition     = aws_elasticache_replication_group.main.multi_az_enabled == true
    error_message = "Replication group must be multi-AZ"
  }

  assert {
    condition     = aws_elasticache_replication_group.main.automatic_failover_enabled == true
    error_message = "Automatic failover must be enabled"
  }

  assert {
    condition     = aws_elasticache_replication_group.main.transit_encryption_enabled == true
    error_message = "In-transit TLS encryption must be enabled"
  }

  assert {
    condition     = aws_elasticache_replication_group.main.at_rest_encryption_enabled == true
    error_message = "At-rest encryption must be enabled"
  }

  assert {
    condition     = aws_elasticache_replication_group.main.kms_key_id == var.platform_kms_key_arn
    error_message = "Must use the platform KMS key for at-rest encryption"
  }

  assert {
    condition     = aws_elasticache_replication_group.main.num_cache_clusters == 2
    error_message = "Must have exactly 1 primary + 1 replica"
  }
}

run "auth_token_written_into_existing_secrets_module_secret" {
  command = apply

  assert {
    condition     = aws_secretsmanager_secret_version.redis_auth.secret_id == var.redis_auth_secret_id
    error_message = "Must write into the EXISTING secret owned by the secrets module, not create a second/duplicate secret at the same name path"
  }

  assert {
    condition     = strcontains(aws_secretsmanager_secret_version.redis_auth.secret_string, "auth_token")
    error_message = "Auth token secret payload must include the auth_token field"
  }
}

run "eviction_policy_is_volatile_lru" {
  command = apply

  assert {
    condition = anytrue([
      for p in aws_elasticache_parameter_group.main.parameter : p.name == "maxmemory-policy" && p.value == "volatile-lru"
    ])
    error_message = "maxmemory-policy must be volatile-lru — see README for why this reconciles the allkeys-lru/noeviction split"
  }
}

run "security_group_only_allows_internal_zone" {
  command = apply

  assert {
    condition     = aws_security_group_rule.redis_ingress_from_internal.source_security_group_id == var.internal_zone_security_group_id
    error_message = "Only the internal-zone security group may reach Redis"
  }

  assert {
    condition     = aws_security_group_rule.redis_ingress_from_internal.from_port == 6379
    error_message = "Ingress must be scoped to the Redis port"
  }
}

run "cloudwatch_alarms_match_acceptance_criteria_thresholds" {
  command = apply

  assert {
    condition     = aws_cloudwatch_metric_alarm.memory_high.threshold == 80
    error_message = "Memory alarm threshold must be 80%"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.cpu_high.threshold == 70
    error_message = "CPU alarm threshold must be 70%"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.replication_lag_high.threshold == 5
    error_message = "Replication lag alarm threshold must be 5 seconds"
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.connections_high.threshold == 1000
    error_message = "Connection count alarm threshold must be 1000"
  }
}
