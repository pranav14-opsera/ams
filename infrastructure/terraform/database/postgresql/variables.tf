variable "region" {
  description = "AWS region for the database instance."
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

variable "data_subnet_ids" {
  description = "Isolated data-zone subnet IDs (from the networking module), one per AZ, with no internet route."
  type        = list(string)

  validation {
    condition     = length(var.data_subnet_ids) >= 2
    error_message = "data_subnet_ids must contain at least 2 entries for a multi-AZ deployment."
  }
}

variable "data_zone_security_group_id" {
  description = "The data-zone security group ID (from the networking module) — already scoped to allow only internal-zone ingress on the database port."
  type        = string
}

variable "platform_kms_key_arn" {
  description = "ARN of the platform KMS key (from the kms module) used to encrypt storage, automated backups, and Performance Insights data."
  type        = string
}

variable "instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.r6g.xlarge"
}

variable "allocated_storage_gb" {
  description = "Initial allocated storage, in GB. Autoscaling grows this up to max_allocated_storage_gb as needed."
  type        = number
  default     = 100
}

variable "max_allocated_storage_gb" {
  description = "Ceiling for RDS storage autoscaling."
  type        = number
  default     = 1000
}

variable "backup_retention_days" {
  description = "Automated backup retention period, in days."
  type        = number
  default     = 35

  validation {
    condition     = var.backup_retention_days >= 35
    error_message = "backup_retention_days must be at least 35 per the acceptance criteria."
  }
}

variable "master_username" {
  description = "Master username for the RDS instance. The password itself is never a Terraform variable — it's generated and stored in Secrets Manager (see infrastructure/terraform/secrets), then Terraform reads it via manage_master_user_password instead."
  type        = string
  default     = "ams_admin"
}

variable "engine_version" {
  description = "PostgreSQL engine version."
  type        = string
  default     = "16.4"
}

variable "monitoring_role_arn" {
  description = "IAM role ARN for RDS Enhanced Monitoring, if enabled."
  type        = string
  default     = null
}
