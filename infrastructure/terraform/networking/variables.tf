variable "region" {
  description = "AWS region to provision the VPC and networking resources in. Parameterized to support multi-region deployment for data residency compliance."
  type        = string

  validation {
    condition     = length(trimspace(var.region)) > 0
    error_message = "region must not be empty."
  }
}

variable "environment" {
  description = "Deployment environment. Each environment is provisioned into its own isolated VPC with identical configuration."
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

variable "az_count" {
  description = "Number of availability zones to spread subnets across. Must match the length of each subnet CIDR list."
  type        = number
  default     = 3

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 6
    error_message = "az_count must be between 2 and 6."
  }
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC. Must support at least 65,000 addresses (a /16 or larger)."
  type        = string
  default     = "10.0.0.0/16"

  validation {
    condition     = can(cidrnetmask(var.vpc_cidr))
    error_message = "vpc_cidr must be a valid IPv4 CIDR block."
  }

  validation {
    condition     = tonumber(split("/", var.vpc_cidr)[1]) <= 16
    error_message = "vpc_cidr must be a /16 or larger to support at least 65,000 addresses."
  }
}

variable "public_subnet_cidrs" {
  description = "CIDR blocks for public (edge zone) subnets, one per AZ. Hosts CDN, API Gateway, and WAF placement."
  type        = list(string)
  default     = ["10.0.0.0/20", "10.0.16.0/20", "10.0.32.0/20"]

  validation {
    condition     = length(var.public_subnet_cidrs) == var.az_count
    error_message = "public_subnet_cidrs must contain exactly az_count entries."
  }

  validation {
    condition     = alltrue([for c in var.public_subnet_cidrs : can(cidrnetmask(c))])
    error_message = "Every entry in public_subnet_cidrs must be a valid IPv4 CIDR block."
  }
}

variable "private_subnet_cidrs" {
  description = "CIDR blocks for private (internal zone) subnets, one per AZ. Hosts application services with outbound-only internet access via NAT."
  type        = list(string)
  default     = ["10.0.48.0/20", "10.0.64.0/20", "10.0.80.0/20"]

  validation {
    condition     = length(var.private_subnet_cidrs) == var.az_count
    error_message = "private_subnet_cidrs must contain exactly az_count entries."
  }

  validation {
    condition     = alltrue([for c in var.private_subnet_cidrs : can(cidrnetmask(c))])
    error_message = "Every entry in private_subnet_cidrs must be a valid IPv4 CIDR block."
  }
}

variable "data_subnet_cidrs" {
  description = "CIDR blocks for isolated data-zone subnets, one per AZ. No internet access; hosts databases, caches, and message brokers."
  type        = list(string)
  default     = ["10.0.96.0/20", "10.0.112.0/20", "10.0.128.0/20"]

  validation {
    condition     = length(var.data_subnet_cidrs) == var.az_count
    error_message = "data_subnet_cidrs must contain exactly az_count entries."
  }

  validation {
    condition     = alltrue([for c in var.data_subnet_cidrs : can(cidrnetmask(c))])
    error_message = "Every entry in data_subnet_cidrs must be a valid IPv4 CIDR block."
  }
}

variable "reserved_cidr_blocks" {
  description = "CIDR ranges reserved by customer VPN peering, on-prem networks, or other external connections. The VPC and all subnet CIDRs are validated to not overlap with any of these."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for c in var.reserved_cidr_blocks : can(cidrnetmask(c))])
    error_message = "Every entry in reserved_cidr_blocks must be a valid IPv4 CIDR block."
  }
}

variable "data_zone_ports" {
  description = "TCP ports the internal zone is permitted to reach in the data zone (PostgreSQL, Redis, Kafka)."
  type        = list(number)
  default     = [5432, 6379, 9092]
}

variable "enable_vpc_endpoints" {
  description = "Whether to create VPC interface/gateway endpoints for S3, KMS, ECR, and CloudWatch Logs. Disable in regions where an endpoint service is unavailable."
  type        = bool
  default     = true
}

variable "flow_log_retention_days" {
  description = "Number of days to retain VPC flow logs in S3 before expiration, per security audit requirements."
  type        = number
  default     = 14

  validation {
    condition     = var.flow_log_retention_days >= 1
    error_message = "flow_log_retention_days must be at least 1."
  }
}

variable "cluster_name" {
  description = "Name of the downstream Kubernetes cluster that will consume these subnets, used for kubernetes.io/cluster tag-based subnet discovery. Leave empty if not yet known."
  type        = string
  default     = ""
}

variable "tags" {
  description = "Additional tags merged into every resource created by this module."
  type        = map(string)
  default     = {}
}
