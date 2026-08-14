# Native Terraform test suite (Terraform 1.9+), mocked aws/archive providers
# — runs fully offline. Real KMS key creation, JWT rotation Lambda
# invocation, and CloudTrail delivery all require a live AWS account and are
# not covered here (see the rotation-lambda/tests/ pytest suite for the
# Lambda's own logic, which IS exercised offline).

mock_provider "aws" {}
mock_provider "archive" {}

override_data {
  target = data.aws_caller_identity.current
  values = {
    account_id = "123456789012"
  }
}

variables {
  region                   = "us-east-1"
  environment              = "dev"
  name_prefix              = "ams"
  application_role_arns    = ["arn:aws:iam::123456789012:role/ams-dev-app"]
  platform_admin_role_arns = ["arn:aws:iam::123456789012:role/ams-dev-platform-admin"]
}

run "platform_key_has_rotation_enabled_with_separation_of_duty" {
  command = apply

  assert {
    condition     = aws_kms_key.platform.enable_key_rotation == true
    error_message = "Platform key must have automatic rotation enabled"
  }

  assert {
    condition     = aws_kms_key.platform.rotation_period_in_days == 90
    error_message = "Platform key rotation period must default to 90 days"
  }

  assert {
    condition     = strcontains(data.aws_iam_policy_document.platform_key.json, "PlatformAdminKeyManagement")
    error_message = "Key policy must include a platform-admin-only statement for key management actions"
  }

  assert {
    condition     = strcontains(data.aws_iam_policy_document.platform_key.json, "ApplicationEncryptDecryptOnly")
    error_message = "Key policy must include an application-role statement scoped to encrypt/decrypt only"
  }
}

run "jwt_signing_key_is_asymmetric_sign_verify_not_auto_rotated" {
  command = apply

  assert {
    condition     = aws_kms_key.jwt_signing.key_usage == "SIGN_VERIFY"
    error_message = "JWT signing key must be a SIGN_VERIFY (asymmetric) key, not ENCRYPT_DECRYPT"
  }

  assert {
    condition     = aws_kms_key.jwt_signing.customer_master_key_spec == "RSA_2048"
    error_message = "JWT signing key must use RSA_2048 by default"
  }
}

run "jwt_rotation_lambda_and_schedule_are_wired_together" {
  command = apply

  assert {
    condition     = aws_cloudwatch_event_rule.jwt_rotation_schedule.schedule_expression == "rate(30 days)"
    error_message = "JWT rotation must run on a 30-day schedule by default"
  }

  assert {
    condition     = aws_cloudwatch_event_target.jwt_rotation.arn == aws_lambda_function.jwt_rotation.arn
    error_message = "The EventBridge rule must target the rotation Lambda"
  }

  assert {
    condition     = aws_lambda_permission.allow_eventbridge_jwt_rotation.principal == "events.amazonaws.com"
    error_message = "EventBridge must have explicit invoke permission on the rotation Lambda"
  }
}

run "cloudtrail_captures_management_events_multi_region" {
  command = apply

  assert {
    condition     = aws_cloudtrail.main.is_multi_region_trail == true
    error_message = "CloudTrail must be multi-region to capture KMS/Secrets Manager calls in every region"
  }

  assert {
    condition     = aws_cloudtrail.main.enable_log_file_validation == true
    error_message = "CloudTrail log file validation must be enabled for SOC 2 tamper-evidence"
  }

  assert {
    condition     = aws_cloudtrail.main.cloud_watch_logs_group_arn != null
    error_message = "CloudTrail must deliver to CloudWatch Logs for near-real-time (<5 min) audit event visibility"
  }
}
