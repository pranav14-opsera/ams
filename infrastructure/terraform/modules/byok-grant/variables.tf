variable "customer_kms_key_arn" {
  description = "ARN of the customer's own KMS key (in their AWS account) that the platform is granted access to for encrypting/decrypting that customer's PHI data. The customer must have already added the platform's grantee principal to their key policy as a grant-eligible principal — this module creates the grant, it does not create the key or its policy."
  type        = string

  validation {
    condition     = can(regex("^arn:aws:kms:[a-z0-9-]+:[0-9]{12}:key/[a-f0-9-]+$", var.customer_kms_key_arn))
    error_message = "customer_kms_key_arn must be a full KMS key ARN (arn:aws:kms:<region>:<account-id>:key/<key-id>)."
  }
}

variable "grantee_principal_arn" {
  description = "ARN of the platform IAM role (in this account) that will be granted encrypt/decrypt/generate-data-key-pair access to the customer's key. Typically the tenant-scoped PHI processing role."
  type        = string
}

variable "tenant_id" {
  description = "Tenant identifier this BYOK grant belongs to — used to name and tag the grant for auditability (which grant belongs to which customer)."
  type        = string
}

variable "retiring_principal_arn" {
  description = "ARN of the IAM role permitted to retire this grant (revoke platform access), typically the same platform-admin role that manages BYOK onboarding/offboarding. Defaults to the grantee principal if not set."
  type        = string
  default     = null
}
