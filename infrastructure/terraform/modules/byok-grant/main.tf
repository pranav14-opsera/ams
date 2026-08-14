# Bring-Your-Own-Key cross-account grant. The customer owns and controls
# their KMS key in their own AWS account; this module only creates a grant
# on that key for the platform's tenant-scoped processing role. The
# customer can retire the grant at any time from their own account,
# independent of anything on the platform side — that's the point of BYOK:
# the customer, not the platform, holds ultimate key control.

resource "aws_kms_grant" "byok" {
  name               = "byok-${var.tenant_id}"
  key_id             = var.customer_kms_key_arn
  grantee_principal  = var.grantee_principal_arn
  retiring_principal = coalesce(var.retiring_principal_arn, var.grantee_principal_arn)

  operations = [
    "Encrypt",
    "Decrypt",
    "GenerateDataKey",
    "GenerateDataKeyPair",
    "DescribeKey",
  ]

  # Bounds every encrypt/decrypt call under this grant to carry an
  # encryption context identifying the tenant — without this, the grant
  # would be usable to encrypt/decrypt data for any tenant, not just the
  # one that owns this key.
  constraints {
    encryption_context_subset = {
      tenant_id = var.tenant_id
    }
  }
}
