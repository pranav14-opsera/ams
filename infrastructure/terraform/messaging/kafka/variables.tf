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
  description = "Isolated data-zone subnet IDs (from the networking module) — exactly 3, one per AZ, per the acceptance criteria."
  type        = list(string)

  validation {
    condition     = length(var.data_subnet_ids) == 3
    error_message = "data_subnet_ids must contain exactly 3 entries — one per AZ, matching the 3-broker/3x-replication requirement."
  }
}

variable "internal_zone_security_group_id" {
  description = "The internal-zone security group ID (from the networking module) — only this may reach Kafka's client ports."
  type        = string
}

variable "platform_kms_key_arn" {
  description = "ARN of the platform KMS key (from the kms module), used for at-rest encryption and the SASL credential secret."
  type        = string
}

variable "kafka_secret_id" {
  description = "ID/ARN of the EXISTING Secrets Manager secret (the \"kafka-sasl-credentials\" entry from the secrets module's managed_secrets map) that this module writes the initial SASL/SCRAM credentials into — mirrors how the cache/redis module wires its auth token, so a second module doesn't create a colliding secret at the same name path."
  type        = string
}

variable "broker_instance_type" {
  description = "MSK broker instance type."
  type        = string
  default     = "kafka.m5.large"
}

variable "broker_storage_gb" {
  description = "EBS storage per broker, in GB."
  type        = number
  default     = 1000
}

variable "kafka_version" {
  description = "MSK Kafka engine version."
  type        = string
  default     = "3.7.x"
}
