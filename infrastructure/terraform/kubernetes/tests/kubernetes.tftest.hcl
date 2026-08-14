# Native Terraform test suite (Terraform 1.9+). Both the aws and kubernetes
# providers are mocked so these run fully offline — no AWS credentials, no
# live cluster required — while still exercising real resource wiring,
# counts, and encryption/namespace config via `command = apply` against the
# mock providers' generated plan.
#
# Real infrastructure validation (an actual EKS cluster, node groups joining,
# the smoke-test Helm chart passing) requires apply against a live AWS
# account and is intentionally not part of this offline suite.

mock_provider "aws" {}
mock_provider "kubernetes" {}

variables {
  region             = "us-east-1"
  environment        = "dev"
  name_prefix        = "ams"
  vpc_id             = "vpc-0123456789abcdef0"
  private_subnet_ids = ["subnet-priv-a", "subnet-priv-b", "subnet-priv-c"]
  data_subnet_ids    = ["subnet-data-a", "subnet-data-b", "subnet-data-c"]
}

run "creates_eks_cluster_with_audit_logging_and_encryption" {
  command = apply

  assert {
    condition     = aws_eks_cluster.main.name == "ams-dev-eks"
    error_message = "Cluster name must follow the {name_prefix}-{environment}-eks convention"
  }

  assert {
    condition     = length(setsubtract(["api", "audit", "authenticator", "controllerManager", "scheduler"], aws_eks_cluster.main.enabled_cluster_log_types)) == 0
    error_message = "All five control plane log types must be enabled for the audit trail"
  }

  assert {
    condition     = aws_eks_cluster.main.encryption_config[0].resources[0] == "secrets"
    error_message = "Cluster must have secrets envelope encryption configured unconditionally"
  }
}

run "creates_three_node_groups_across_correct_subnet_tiers" {
  command = apply

  assert {
    condition     = aws_eks_node_group.system.subnet_ids == var.private_subnet_ids
    error_message = "System node group must run in the private (internal) subnets"
  }

  assert {
    condition     = aws_eks_node_group.application.subnet_ids == var.private_subnet_ids
    error_message = "Application node group must run in the private (internal) subnets"
  }

  assert {
    condition     = aws_eks_node_group.data.subnet_ids == var.data_subnet_ids
    error_message = "Data node group must run in the isolated data subnets, not the private subnets"
  }

  assert {
    condition     = aws_eks_node_group.system.scaling_config[0].min_size >= 3
    error_message = "Every node group must maintain a minimum of 3 nodes for multi-AZ resilience"
  }

  assert {
    condition     = aws_eks_node_group.application.scaling_config[0].max_size <= 12
    error_message = "Application node group max_size must not exceed 12 per the acceptance criteria"
  }
}

run "encrypts_all_node_group_ebs_volumes" {
  command = apply

  assert {
    condition     = aws_launch_template.system.block_device_mappings[0].ebs[0].encrypted == true
    error_message = "System node group EBS volumes must be encrypted"
  }

  assert {
    condition     = aws_launch_template.application.block_device_mappings[0].ebs[0].encrypted == true
    error_message = "Application node group EBS volumes must be encrypted"
  }

  assert {
    condition     = aws_launch_template.data.block_device_mappings[0].ebs[0].encrypted == true
    error_message = "Data node group EBS volumes must be encrypted"
  }
}

run "creates_all_bounded_context_and_system_namespaces" {
  command = apply

  assert {
    condition     = length(kubernetes_namespace.bounded_context) == 6
    error_message = "Expected 6 bounded-context namespaces: identity-access, agent-management, observability, financial, governance, compliance"
  }

  assert {
    condition     = length(kubernetes_namespace.system) == 3
    error_message = "Expected 3 system namespaces: ingress-nginx, monitoring, cert-manager"
  }

  assert {
    condition     = length(kubernetes_resource_quota.bounded_context) == 6
    error_message = "Every bounded-context namespace must have a ResourceQuota"
  }

  assert {
    condition     = length(kubernetes_limit_range.bounded_context) == 6
    error_message = "Every bounded-context namespace must have a LimitRange"
  }
}

run "applies_default_deny_network_policy_to_every_bounded_context_namespace" {
  command = apply

  assert {
    condition     = length(kubernetes_network_policy.default_deny) == 6
    error_message = "Every bounded-context namespace must have a default-deny NetworkPolicy"
  }

  assert {
    condition     = alltrue([for np in kubernetes_network_policy.default_deny : length(np.spec[0].policy_types) == 2])
    error_message = "Default-deny policy must cover both Ingress and Egress"
  }

  assert {
    condition     = length(kubernetes_network_policy.allow_dns_egress) == 6
    error_message = "Every bounded-context namespace must allow DNS egress, or service discovery breaks under default-deny"
  }
}
