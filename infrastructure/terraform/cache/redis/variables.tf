variable "region" {
  description = "AWS region."
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
  description = "Isolated data-zone subnet IDs (from the networking module), one per AZ."
  type        = list(string)

  validation {
    condition     = length(var.data_subnet_ids) >= 2
    error_message = "data_subnet_ids must contain at least 2 entries for automatic failover."
  }
}

variable "internal_zone_security_group_id" {
  description = "The internal-zone security group ID (from the networking module) — only this security group may reach Redis on port 6379."
  type        = string
}

variable "platform_kms_key_arn" {
  description = "ARN of the platform KMS key (from the kms module), used for at-rest encryption."
  type        = string
}

variable "redis_auth_secret_id" {
  description = "ID/ARN of the EXISTING Secrets Manager secret (the \"redis-auth-token\" entry from the secrets module's managed_secrets map) that this module writes the initial host/port/auth_token payload into. This module does not create its own secret — see main.tf's header comment for why."
  type        = string
}

variable "node_type" {
  description = <<-EOT
    ElastiCache node instance type. ElastiCache does not expose a direct
    "cap total memory at N MB" parameter independent of the node's actual
    RAM (unlike self-managed Redis's `maxmemory` directive) — the way to
    hit the acceptance criteria's 500MB memory-limit target is choosing a
    node type whose usable memory is close to it. cache.t4g.micro provides
    ~0.5 GiB, matching the target.
  EOT
  type        = string
  default     = "cache.t4g.micro"
}

variable "snapshot_retention_days" {
  description = "Number of days to retain automatic ElastiCache snapshots."
  type        = number
  default     = 7
}
