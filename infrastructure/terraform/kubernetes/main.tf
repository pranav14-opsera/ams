locals {
  cluster_name = "${var.name_prefix}-${var.environment}-eks"

  common_tags = merge({
    Project     = var.name_prefix
    Environment = var.environment
    ManagedBy   = "terraform"
    Module      = "kubernetes"
    VpcId       = var.vpc_id
  }, var.tags)

  all_node_subnet_ids = distinct(concat(var.private_subnet_ids, var.data_subnet_ids))
}

# --- KMS key for envelope encryption of Kubernetes secrets -------------------
# Unconditional — not behind a variable toggle. Secrets envelope encryption
# is a hard requirement for this platform (PHI-adjacent tenant data), not an
# opt-in.

data "aws_caller_identity" "current" {}

# This is a KMS *key* policy, not an IAM identity policy: `resources = ["*"]`
# in a key-policy statement is AWS's required syntax (the resource is
# implicitly "this key"), not an unconstrained cross-resource grant.
#checkov:skip=CKV_AWS_109:resources="*" is required key-policy syntax, not an unconstrained identity-policy grant
#checkov:skip=CKV_AWS_111:resources="*" is required key-policy syntax, not an unconstrained identity-policy grant
#checkov:skip=CKV_AWS_356:resources="*" is required key-policy syntax, not an unconstrained identity-policy grant
data "aws_iam_policy_document" "eks_secrets_key" {
  # Root-account admin access on the key — required so the key doesn't lock
  # the account out of managing it — plus explicit grants for the two AWS
  # services that need to use it (EKS for secrets envelope encryption,
  # CloudWatch Logs for the audit log group below).
  statement {
    sid       = "AccountRootFullAccess"
    effect    = "Allow"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  statement {
    sid       = "AllowEKSSecretsEncryption"
    effect    = "Allow"
    actions   = ["kms:Encrypt", "kms:Decrypt", "kms:DescribeKey", "kms:GenerateDataKey*"]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["eks.amazonaws.com"]
    }
  }

  statement {
    sid       = "AllowCloudWatchLogsEncryption"
    effect    = "Allow"
    actions   = ["kms:Encrypt*", "kms:Decrypt*", "kms:ReEncrypt*", "kms:GenerateDataKey*", "kms:Describe*"]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["logs.${var.region}.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/eks/${local.cluster_name}/cluster"]
    }
  }
}

resource "aws_kms_key" "eks_secrets" {
  description             = "Envelope encryption key for ${local.cluster_name} Kubernetes secrets"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.eks_secrets_key.json

  tags = merge(local.common_tags, {
    Name = "${local.cluster_name}-secrets-key"
  })
}

resource "aws_kms_alias" "eks_secrets" {
  name          = "alias/${local.cluster_name}-secrets"
  target_key_id = aws_kms_key.eks_secrets.key_id
}

# --- IAM: cluster role --------------------------------------------------------

data "aws_iam_policy_document" "eks_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cluster" {
  name               = "${local.cluster_name}-cluster-role"
  assume_role_policy = data.aws_iam_policy_document.eks_assume_role.json

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "cluster_policy" {
  role       = aws_iam_role.cluster.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}

resource "aws_iam_role_policy_attachment" "cluster_vpc_resource_controller" {
  role       = aws_iam_role.cluster.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSVPCResourceController"
}

# --- CloudWatch log group for control plane audit logging --------------------

resource "aws_cloudwatch_log_group" "cluster" {
  name              = "/aws/eks/${local.cluster_name}/cluster"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.eks_secrets.arn

  tags = local.common_tags
}

# --- EKS cluster ---------------------------------------------------------

resource "aws_eks_cluster" "main" {
  name     = local.cluster_name
  version  = var.cluster_version
  role_arn = aws_iam_role.cluster.arn

  vpc_config {
    subnet_ids              = local.all_node_subnet_ids
    security_group_ids      = var.cluster_security_group_ids
    endpoint_private_access = true
    endpoint_public_access  = length(var.cluster_endpoint_public_access_cidrs) > 0
    public_access_cidrs     = length(var.cluster_endpoint_public_access_cidrs) > 0 ? var.cluster_endpoint_public_access_cidrs : null
  }

  # Audit logging to CloudWatch — every control plane log type enabled for
  # the security/compliance audit trail this platform requires.
  enabled_cluster_log_types = ["api", "audit", "authenticator", "controllerManager", "scheduler"]

  encryption_config {
    provider {
      key_arn = aws_kms_key.eks_secrets.arn
    }
    resources = ["secrets"]
  }

  tags = merge(local.common_tags, {
    Name = local.cluster_name
  })

  depends_on = [
    aws_iam_role_policy_attachment.cluster_policy,
    aws_iam_role_policy_attachment.cluster_vpc_resource_controller,
    aws_cloudwatch_log_group.cluster,
  ]
}

# --- IAM: shared node role -----------------------------------------------

data "aws_iam_policy_document" "node_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "node" {
  name               = "${local.cluster_name}-node-role"
  assume_role_policy = data.aws_iam_policy_document.node_assume_role.json

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "node_worker" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy"
}

resource "aws_iam_role_policy_attachment" "node_cni" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy"
}

resource "aws_iam_role_policy_attachment" "node_ecr_readonly" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

# --- Launch templates: enforce encrypted EBS volumes on every node group ----

resource "aws_launch_template" "system" {
  name_prefix = "${local.cluster_name}-system-"

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size = var.system_node_group.disk_size_gb
      volume_type = "gp3"
      encrypted   = true
    }
  }

  metadata_options {
    http_tokens   = "required" # IMDSv2 only
    http_endpoint = "enabled"
  }

  tag_specifications {
    resource_type = "instance"
    tags          = merge(local.common_tags, { Name = "${local.cluster_name}-system-node", NodeGroup = "system" })
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_launch_template" "application" {
  name_prefix = "${local.cluster_name}-application-"

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size = var.application_node_group.disk_size_gb
      volume_type = "gp3"
      encrypted   = true
    }
  }

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }

  tag_specifications {
    resource_type = "instance"
    tags          = merge(local.common_tags, { Name = "${local.cluster_name}-application-node", NodeGroup = "application" })
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_launch_template" "data" {
  name_prefix = "${local.cluster_name}-data-"

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size = var.data_node_group.disk_size_gb
      volume_type = "gp3"
      encrypted   = true
    }
  }

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }

  tag_specifications {
    resource_type = "instance"
    tags          = merge(local.common_tags, { Name = "${local.cluster_name}-data-node", NodeGroup = "data" })
  }

  lifecycle {
    create_before_destroy = true
  }
}

# --- Node groups ---------------------------------------------------------
# System and application workloads run in the internal (private) subnets;
# the data node group runs in the isolated data subnets alongside the
# databases/caches/brokers it's colocated with for latency and blast-radius
# reasons.

resource "aws_eks_node_group" "system" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "system"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = var.private_subnet_ids
  instance_types  = var.system_node_group.instance_types

  scaling_config {
    min_size     = max(var.system_node_group.min_size, 3)
    max_size     = var.system_node_group.max_size
    desired_size = var.system_node_group.desired_size
  }

  launch_template {
    id      = aws_launch_template.system.id
    version = aws_launch_template.system.latest_version
  }

  labels = {
    "workload-tier" = "system"
  }

  taint {
    key    = "workload-tier"
    value  = "system"
    effect = "PREFER_NO_SCHEDULE"
  }

  tags = local.common_tags

  depends_on = [
    aws_iam_role_policy_attachment.node_worker,
    aws_iam_role_policy_attachment.node_cni,
    aws_iam_role_policy_attachment.node_ecr_readonly,
  ]

  lifecycle {
    ignore_changes = [scaling_config[0].desired_size]
  }
}

resource "aws_eks_node_group" "application" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "application"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = var.private_subnet_ids
  instance_types  = var.application_node_group.instance_types

  scaling_config {
    min_size     = max(var.application_node_group.min_size, 3)
    max_size     = var.application_node_group.max_size
    desired_size = var.application_node_group.desired_size
  }

  launch_template {
    id      = aws_launch_template.application.id
    version = aws_launch_template.application.latest_version
  }

  labels = {
    "workload-tier" = "application"
  }

  tags = local.common_tags

  depends_on = [
    aws_iam_role_policy_attachment.node_worker,
    aws_iam_role_policy_attachment.node_cni,
    aws_iam_role_policy_attachment.node_ecr_readonly,
  ]

  lifecycle {
    ignore_changes = [scaling_config[0].desired_size]
  }
}

resource "aws_eks_node_group" "data" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "data"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = var.data_subnet_ids
  instance_types  = var.data_node_group.instance_types

  scaling_config {
    min_size     = max(var.data_node_group.min_size, 3)
    max_size     = var.data_node_group.max_size
    desired_size = var.data_node_group.desired_size
  }

  launch_template {
    id      = aws_launch_template.data.id
    version = aws_launch_template.data.latest_version
  }

  labels = {
    "workload-tier" = "data"
  }

  taint {
    key    = "workload-tier"
    value  = "data"
    effect = "NO_SCHEDULE"
  }

  tags = local.common_tags

  depends_on = [
    aws_iam_role_policy_attachment.node_worker,
    aws_iam_role_policy_attachment.node_cni,
    aws_iam_role_policy_attachment.node_ecr_readonly,
  ]

  lifecycle {
    ignore_changes = [scaling_config[0].desired_size]
  }
}
