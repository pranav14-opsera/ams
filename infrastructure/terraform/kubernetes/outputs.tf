output "cluster_name" {
  description = "Name of the EKS cluster."
  value       = aws_eks_cluster.main.name
}

output "cluster_endpoint" {
  description = "API server endpoint of the EKS cluster."
  value       = aws_eks_cluster.main.endpoint
}

output "cluster_certificate_authority_data" {
  description = "Base64-encoded certificate authority data for the cluster."
  value       = aws_eks_cluster.main.certificate_authority[0].data
  sensitive   = true
}

output "cluster_version" {
  description = "Kubernetes version running on the control plane."
  value       = aws_eks_cluster.main.version
}

output "cluster_oidc_issuer_url" {
  description = "OIDC issuer URL for the cluster, used to configure IRSA (IAM Roles for Service Accounts)."
  value       = aws_eks_cluster.main.identity[0].oidc[0].issuer
}

output "cluster_security_group_id" {
  description = "ID of the security group EKS creates for the control plane's cross-node communication."
  value       = aws_eks_cluster.main.vpc_config[0].cluster_security_group_id
}

output "node_role_arn" {
  description = "ARN of the shared IAM role assumed by all node groups."
  value       = aws_iam_role.node.arn
}

output "node_group_names" {
  description = "Names of the three node groups (system, application, data)."
  value = {
    system      = aws_eks_node_group.system.node_group_name
    application = aws_eks_node_group.application.node_group_name
    data        = aws_eks_node_group.data.node_group_name
  }
}

output "kms_key_arn" {
  description = "ARN of the KMS key used for Kubernetes secrets envelope encryption."
  value       = aws_kms_key.eks_secrets.arn
}

output "bounded_context_namespaces" {
  description = "Names of the created bounded-context namespaces."
  value       = [for ns in kubernetes_namespace.bounded_context : ns.metadata[0].name]
}

output "system_namespaces" {
  description = "Names of the created system namespaces."
  value       = [for ns in kubernetes_namespace.system : ns.metadata[0].name]
}

output "cloudwatch_log_group_name" {
  description = "Name of the CloudWatch log group receiving control plane audit logs."
  value       = aws_cloudwatch_log_group.cluster.name
}

output "hpa_cpu_threshold_percent" {
  description = <<-EOT
    Target CPU utilization percentage for HPAs, single-sourced here so the
    infrastructure/helm/base-service chart's --set autoscaling.cpuUtilizationPercent
    stays in sync with this module rather than drifting to its own hardcoded
    default.
  EOT
  value       = var.hpa_cpu_threshold_percent
}

output "gateway_hostname" {
  description = "Public DNS hostname the API gateway (WO-026) is issued a TLS certificate for."
  value       = var.gateway_hostname
}

output "gateway_internal_ca_secret_name" {
  description = "Name of the Secret (in the cert-manager namespace) holding the internal CA used to issue every backend service's mTLS certificate."
  value       = "ams-internal-ca-secret"
}
