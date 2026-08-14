variable "region" {
  description = "AWS region to provision KMS keys and the rotation Lambda in."
  type        = string

  validation {
    condition     = length(trimspace(var.region)) > 0
    error_message = "region must not be empty."
  }
}

variable "environment" {
  description = "Deployment environment."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "name_prefix" {
  description = "Prefix applied to all resource names and tags, e.g. 'ams'."
  type        = string
  default     = "ams"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,20}$", var.name_prefix))
    error_message = "name_prefix must be lowercase alphanumeric/hyphen, starting with a letter, 21 chars or fewer."
  }
}

variable "platform_key_rotation_days" {
  description = "Automatic rotation period, in days, for the platform's symmetric AES-256 KMS key."
  type        = number
  default     = 90

  validation {
    condition     = var.platform_key_rotation_days >= 90 && var.platform_key_rotation_days <= 2560
    error_message = "platform_key_rotation_days must be between 90 and 2560 (AWS KMS's supported range)."
  }
}

variable "application_role_arns" {
  description = "IAM role ARNs of application services permitted to encrypt/decrypt with the platform key (e.g. database, cache, message-broker access roles from WO-001/WO-002)."
  type        = list(string)
  default     = []
}

variable "platform_admin_role_arns" {
  description = "IAM role ARNs permitted to manage key policies, grants, and rotation configuration (separation-of-duty admin tier). Application roles must never appear here."
  type        = list(string)
  default     = []
}

variable "jwt_signing_key_spec" {
  description = "KMS asymmetric key spec for the JWT signing key pair."
  type        = string
  default     = "RSA_2048"
}

variable "jwt_rotation_schedule_expression" {
  description = "EventBridge schedule expression for JWT signing key rotation."
  type        = string
  default     = "rate(30 days)"
}

variable "jwt_key_overlap_days" {
  description = "Number of days the previous JWT signing key remains valid for token verification after a new key is issued, before it's scheduled for deletion."
  type        = number
  default     = 7
}
