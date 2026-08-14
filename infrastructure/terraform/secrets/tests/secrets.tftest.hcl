# Native Terraform test suite (Terraform 1.9+), mocked aws/archive providers
# — runs fully offline. See rotation-lambda/tests/ for the Lambda's own
# rotation-protocol logic (exercised offline against a fake Secrets Manager
# client); this suite only covers resource wiring.

mock_provider "aws" {}
mock_provider "archive" {}

variables {
  region                   = "us-east-1"
  environment              = "dev"
  name_prefix              = "ams"
  platform_kms_key_arn     = "arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555"
  vpc_id                   = "vpc-0123456789abcdef0"
  private_subnet_ids       = ["subnet-a", "subnet-b", "subnet-c"]
  application_role_arns    = ["arn:aws:iam::123456789012:role/ams-dev-app"]
  platform_admin_role_arns = ["arn:aws:iam::123456789012:role/ams-dev-platform-admin"]
}

run "creates_all_three_default_managed_secrets_with_rotation" {
  command = apply

  assert {
    condition     = length(aws_secretsmanager_secret.managed) == 3
    error_message = "Expected the three default managed secrets: database-credentials, redis-auth-token, kafka-sasl-credentials"
  }

  assert {
    condition     = alltrue([for r in aws_secretsmanager_secret_rotation.managed : r.rotation_rules[0].automatically_after_days == 90])
    error_message = "Every managed secret must rotate every 90 days by default"
  }

  assert {
    condition     = alltrue([for s in aws_secretsmanager_secret.managed : s.kms_key_id == var.platform_kms_key_arn])
    error_message = "Every managed secret must be encrypted with the platform KMS key"
  }
}

run "rotation_lambda_runs_in_the_private_subnets" {
  command = apply

  assert {
    condition     = aws_lambda_function.secret_rotation.vpc_config[0].subnet_ids == var.private_subnet_ids
    error_message = "Rotation Lambda must run in the provided private subnets to reach the database/cache/broker"
  }
}

run "separation_of_duty_resource_policy_applied_to_every_secret" {
  command = apply

  assert {
    condition     = length(aws_secretsmanager_secret_policy.managed) == 3
    error_message = "Every managed secret must get the separation-of-duty resource policy when app/admin role ARNs are configured"
  }

  assert {
    condition = alltrue([
      for k, doc in data.aws_iam_policy_document.secret_resource_policy :
      strcontains(doc.json, "ApplicationReadOnly") && strcontains(doc.json, "PlatformAdminFullAccess")
    ])
    error_message = "Each secret's resource policy must separate application read-only access from platform-admin full access"
  }
}
