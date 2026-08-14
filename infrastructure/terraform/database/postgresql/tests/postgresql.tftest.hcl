# Native Terraform test suite (Terraform 1.9+), mocked aws provider — runs
# fully offline. The actual migrations, RLS policies, hash-chain trigger,
# and adversarial cross-tenant isolation test are all exercised for real
# against a live local PostgreSQL instance — see database/tests/ and this
# WO's PR description for that verification; it isn't (and can't be)
# re-derived from a mocked Terraform provider.

mock_provider "aws" {}

variables {
  region                      = "us-east-1"
  environment                 = "dev"
  name_prefix                 = "ams"
  data_subnet_ids             = ["subnet-data-a", "subnet-data-b", "subnet-data-c"]
  data_zone_security_group_id = "sg-0123456789abcdef0"
  platform_kms_key_arn        = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555"
}

run "instance_is_multi_az_encrypted_with_platform_key" {
  command = apply

  assert {
    condition     = aws_db_instance.main.multi_az == true
    error_message = "RDS instance must be multi-AZ"
  }

  assert {
    condition     = aws_db_instance.main.storage_encrypted == true
    error_message = "Storage must be encrypted"
  }

  assert {
    condition     = aws_db_instance.main.kms_key_id == var.platform_kms_key_arn
    error_message = "Must use the platform KMS key for storage encryption"
  }

  assert {
    condition     = aws_db_instance.main.backup_retention_period >= 35
    error_message = "Backup retention must be at least 35 days per the acceptance criteria"
  }

  assert {
    condition     = aws_db_instance.main.manage_master_user_password == true
    error_message = "Master password must be Secrets-Manager-managed, never a plain Terraform variable"
  }
}

run "connection_pooling_via_rds_proxy" {
  command = apply

  assert {
    condition     = aws_db_proxy.main.engine_family == "POSTGRESQL"
    error_message = "RDS Proxy must target the PostgreSQL engine family"
  }

  assert {
    condition     = aws_db_proxy.main.require_tls == true
    error_message = "RDS Proxy must require TLS"
  }

  assert {
    condition     = aws_db_proxy_target.main.db_instance_identifier == aws_db_instance.main.identifier
    error_message = "Proxy target must point at this module's own RDS instance"
  }
}

run "parameter_group_forces_ssl_and_does_not_claim_timescaledb" {
  command = apply

  assert {
    condition = anytrue([
      for p in aws_db_parameter_group.main.parameter : p.name == "rds.force_ssl" && p.value == "1"
    ])
    error_message = "Parameter group must force SSL connections"
  }

  assert {
    condition = !anytrue([
      for p in aws_db_parameter_group.main.parameter : p.name == "shared_preload_libraries"
    ])
    error_message = "Parameter group must NOT claim shared_preload_libraries=timescaledb — AWS RDS PostgreSQL does not support the TimescaleDB extension; see main.tf's comment and migrations/007's native-partitioning substitute"
  }
}
