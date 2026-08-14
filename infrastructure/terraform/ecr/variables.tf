variable "region" {
  description = "AWS region to provision ECR repositories in."
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
}

variable "repository_names" {
  description = "Container image repository names to create (e.g. [\"ams-frontend\", \"ams-backend\"])."
  type        = list(string)

  validation {
    condition     = length(var.repository_names) > 0
    error_message = "repository_names must not be empty."
  }
}

variable "kms_key_arn" {
  description = "ARN of the KMS key used to encrypt image layers at rest (the platform key from infrastructure/terraform/kms)."
  type        = string
}

variable "image_signing_pipeline_role_arn" {
  description = "IAM role ARN of the CI/CD pipeline service account permitted to push images. Empty string skips the repository policy (account root retains default access either way)."
  type        = string
  default     = ""
}

variable "untagged_image_expiry_days" {
  description = "Days after which an untagged image is expired by the lifecycle policy."
  type        = number
  default     = 14
}
