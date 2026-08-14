variable "region" {
  description = "AWS region for Secrets Manager secrets and the rotation Lambda."
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

variable "platform_kms_key_arn" {
  description = "ARN of the platform KMS key (from the kms module) used to encrypt every secret this module manages."
  type        = string
}

variable "rotation_days" {
  description = "Automatic rotation period, in days, applied to every managed secret."
  type        = number
  default     = 90
}

variable "application_role_arns" {
  description = "IAM role ARNs of application services permitted to read (GetSecretValue) secrets, but never to modify rotation configuration or secret metadata — separation of duty."
  type        = list(string)
  default     = []
}

variable "platform_admin_role_arns" {
  description = "IAM role ARNs permitted to manage secrets (create/update/delete/configure rotation). Application roles must never appear here."
  type        = list(string)
  default     = []
}

variable "vpc_id" {
  description = "VPC ID the rotation Lambda runs in, so it can reach the database/cache/broker it rotates credentials for."
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR block of the VPC (from the networking module), used to scope the rotation Lambda's egress rule instead of 0.0.0.0/0. The Lambda's only network targets — the database, cache, and broker being rotated — are all inside this VPC."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for the rotation Lambda's VPC configuration."
  type        = list(string)
}

variable "rotation_lambda_security_group_ids" {
  description = "Security group IDs granting the rotation Lambda network access to the database/cache/broker (e.g. the internal-zone security group from the networking module)."
  type        = list(string)
  default     = []
}

variable "managed_secrets" {
  description = <<-EOT
    Map of secret name => config for every credential this module manages
    and rotates. secret_type drives which rotation strategy the Lambda uses
    (postgres, redis, kafka_scram).
  EOT
  type = map(object({
    secret_type = string
    description = string
  }))
  default = {
    "database-credentials" = {
      secret_type = "postgres"
      description = "PostgreSQL application database credentials (WO-004)"
    }
    "redis-auth-token" = {
      secret_type = "redis"
      description = "Redis AUTH token (WO-005)"
    }
    "kafka-sasl-credentials" = {
      secret_type = "kafka_scram"
      description = "Kafka SASL/SCRAM credentials (WO-006)"
    }
  }
}
