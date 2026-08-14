variable "region" {
  description = "AWS region to provision the cluster in. Parameterized to support multi-region deployment for data residency compliance."
  type        = string

  validation {
    condition     = length(trimspace(var.region)) > 0
    error_message = "region must not be empty."
  }
}

variable "environment" {
  description = "Deployment environment. Each environment gets its own isolated cluster."
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

variable "cluster_version" {
  description = "Kubernetes version for the EKS control plane."
  type        = string
  default     = "1.31"
}

# --- Networking (consumed from the networking module's outputs) -----------

variable "vpc_id" {
  description = "ID of the VPC to provision the cluster into (output of the networking module)."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private (internal zone) subnet IDs, one per AZ, hosting the EKS control plane ENIs and application node groups."
  type        = list(string)

  validation {
    condition     = length(var.private_subnet_ids) >= 3
    error_message = "private_subnet_ids must contain at least 3 entries to satisfy the multi-AZ requirement."
  }
}

variable "data_subnet_ids" {
  description = "Isolated data-zone subnet IDs, one per AZ, hosting the data node group."
  type        = list(string)

  validation {
    condition     = length(var.data_subnet_ids) >= 3
    error_message = "data_subnet_ids must contain at least 3 entries to satisfy the multi-AZ requirement."
  }
}

variable "cluster_security_group_ids" {
  description = "Additional security group IDs to attach to the EKS control plane ENIs (e.g. the internal-zone security group from the networking module)."
  type        = list(string)
  default     = []
}

variable "cluster_endpoint_public_access_cidrs" {
  description = <<-EOT
    CIDR blocks allowed to reach the EKS public API endpoint. Empty (the
    default) disables the public endpoint entirely — kubectl/CI must reach
    the cluster via the private endpoint (VPN, bastion, or a runner inside
    the VPC). Set explicit, narrow CIDRs here to enable public access rather
    than defaulting to 0.0.0.0/0.
  EOT
  type        = list(string)
  default     = []

  validation {
    condition     = !contains(var.cluster_endpoint_public_access_cidrs, "0.0.0.0/0")
    error_message = "cluster_endpoint_public_access_cidrs must not contain 0.0.0.0/0 — list specific, narrow CIDR ranges."
  }
}

# --- Node groups -------------------------------------------------------------

variable "system_node_group" {
  description = "Sizing/instance config for the system node group (ingress-nginx, cert-manager, monitoring)."
  type = object({
    instance_types = list(string)
    min_size       = number
    max_size       = number
    desired_size   = number
    disk_size_gb   = number
  })
  default = {
    instance_types = ["m6i.large"]
    min_size       = 3
    max_size       = 6
    desired_size   = 3
    disk_size_gb   = 50
  }
}

variable "application_node_group" {
  description = "Sizing/instance config for the application node group (bounded-context services)."
  type = object({
    instance_types = list(string)
    min_size       = number
    max_size       = number
    desired_size   = number
    disk_size_gb   = number
  })
  default = {
    instance_types = ["m6i.xlarge"]
    min_size       = 3
    max_size       = 12
    desired_size   = 4
    disk_size_gb   = 100
  }
}

variable "data_node_group" {
  description = "Sizing/instance config for the data node group (stateful workloads, data-zone subnets)."
  type = object({
    instance_types = list(string)
    min_size       = number
    max_size       = number
    desired_size   = number
    disk_size_gb   = number
  })
  default = {
    instance_types = ["r6i.xlarge"]
    min_size       = 3
    max_size       = 6
    desired_size   = 3
    disk_size_gb   = 200
  }
}

# --- Bounded contexts / namespaces -------------------------------------------

variable "bounded_context_namespaces" {
  description = "Application bounded-context namespaces created on the cluster, each with its own resource quota and limit range."
  type        = list(string)
  default = [
    "identity-access",
    "agent-management",
    "observability",
    "financial",
    "governance",
    "compliance",
  ]
}

variable "system_namespaces" {
  description = "System/platform namespaces created on the cluster (ingress, monitoring, cert management)."
  type        = list(string)
  default = [
    "ingress-nginx",
    "monitoring",
    "cert-manager",
  ]
}

variable "namespace_resource_quota" {
  description = "Default ResourceQuota applied to every bounded-context namespace to prevent noisy-neighbor resource exhaustion."
  type = object({
    requests_cpu    = string
    requests_memory = string
    limits_cpu      = string
    limits_memory   = string
    max_pods        = number
  })
  default = {
    requests_cpu    = "8"
    requests_memory = "16Gi"
    limits_cpu      = "16"
    limits_memory   = "32Gi"
    max_pods        = 50
  }
}

variable "hpa_cpu_threshold_percent" {
  description = "Target average CPU utilization percentage for the base Helm chart's HorizontalPodAutoscaler."
  type        = number
  default     = 70

  validation {
    condition     = var.hpa_cpu_threshold_percent > 0 && var.hpa_cpu_threshold_percent <= 100
    error_message = "hpa_cpu_threshold_percent must be between 1 and 100."
  }
}

variable "tags" {
  description = "Additional tags merged into every resource created by this module."
  type        = map(string)
  default     = {}
}

# --- API Gateway (WO-026) ---------------------------------------------------

variable "tls_admin_email" {
  description = "Contact email registered with the ACME (Let's Encrypt) account that issues the gateway's public-facing TLS certificate."
  type        = string
  default     = "platform-oncall@ams.example.com"
}

variable "gateway_hostname" {
  description = "Public DNS hostname the API gateway's Ingress is issued a TLS certificate for and routes traffic on."
  type        = string
  default     = "api.ams.example.com"
}

# path prefix -> which bounded-context namespace/service currently serves
# it. Every group routes to the SAME single "ams-backend" service today
# (this platform is presently one NestJS monolith, not yet split into
# per-bounded-context microservices) — this map is what becomes a real
# multi-service routing table as each bounded context's own service is
# built out, without any Ingress-resource restructuring later.
variable "gateway_route_backends" {
  description = "Path-prefix routing table: which namespace/service/port currently serves each API path group."
  type = map(object({
    namespace = string
    service   = string
    port      = number
  }))
  default = {
    "/api/v1/agents"     = { namespace = "agent-management", service = "ams-backend", port = 80 }
    "/api/v1/credits"    = { namespace = "financial", service = "ams-backend", port = 80 }
    "/api/v1/governance" = { namespace = "governance", service = "ams-backend", port = 80 }
    "/api/v1/audit"      = { namespace = "compliance", service = "ams-backend", port = 80 }
    "/api/v1/auth"       = { namespace = "identity-access", service = "ams-backend", port = 80 }
    "/api/v1/workflows"  = { namespace = "agent-management", service = "ams-backend", port = 80 }
    "/api/v1/rbac"       = { namespace = "identity-access", service = "ams-backend", port = 80 }
    "/api/v1/tenants"    = { namespace = "identity-access", service = "ams-backend", port = 80 }
    "/scim/v2"           = { namespace = "identity-access", service = "ams-backend", port = 80 }
    "/adapters"          = { namespace = "agent-management", service = "adapter-gateway", port = 80 }
    "/health"            = { namespace = "identity-access", service = "ams-backend", port = 80 }
  }
}
