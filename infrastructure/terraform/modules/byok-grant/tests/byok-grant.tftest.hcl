mock_provider "aws" {}

variables {
  customer_kms_key_arn  = "arn:aws:kms:us-east-1:999999999999:key/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
  grantee_principal_arn = "arn:aws:iam::123456789012:role/ams-dev-phi-processor"
  tenant_id             = "acme-health"
}

run "grant_scoped_to_tenant_via_encryption_context" {
  command = apply

  assert {
    condition     = aws_kms_grant.byok.constraints[0].encryption_context_subset["tenant_id"] == "acme-health"
    error_message = "Grant must constrain usage to this tenant's encryption context so it can't be used to decrypt another tenant's data"
  }

  assert {
    condition     = length(setsubtract(["Encrypt", "Decrypt", "GenerateDataKey", "GenerateDataKeyPair", "DescribeKey"], aws_kms_grant.byok.operations)) == 0
    error_message = "Grant must include all required PHI encrypt/decrypt operations"
  }

  assert {
    condition     = aws_kms_grant.byok.retiring_principal == "arn:aws:iam::123456789012:role/ams-dev-phi-processor"
    error_message = "retiring_principal must default to the grantee principal when not explicitly set"
  }
}
