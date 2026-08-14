provider "aws" {
  region = var.region
}

# The Kubernetes provider authenticates against the cluster this module just
# created — token auth via the AWS EKS API rather than a static kubeconfig,
# so `terraform apply` works immediately after cluster creation with no
# manual kubeconfig step in between.
provider "kubernetes" {
  host                   = aws_eks_cluster.main.endpoint
  cluster_ca_certificate = base64decode(aws_eks_cluster.main.certificate_authority[0].data)

  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args        = ["eks", "get-token", "--cluster-name", aws_eks_cluster.main.name, "--region", var.region]
  }
}
