# Container image registries (WO-012). image_tag_mutability = IMMUTABLE is
# the load-bearing setting here: once a git-SHA tag is pushed and signed,
# nobody — not even someone with push access — can silently retag a
# different (unsigned, unscanned) image onto that same tag afterward. A
# mutable tag would let a signature verification pass for content that was
# never actually scanned.

locals {
  common_tags = {
    Project     = var.name_prefix
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

resource "aws_ecr_repository" "this" {
  for_each = toset(var.repository_names)

  name                 = each.value
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true # basic ECR scan-on-push, in addition to (not instead of) the pipeline's own grype scan (WO-008) — defense in depth against an image built here and pushed by a path that skipped the pipeline
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = var.kms_key_arn
  }

  tags = merge(local.common_tags, { Name = each.value })
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each   = aws_ecr_repository.this
  repository = each.value.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Expire untagged images after ${var.untagged_image_expiry_days} days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = var.untagged_image_expiry_days
        }
        action = { type = "expire" }
      }
    ]
  })
}

data "aws_iam_policy_document" "repository_policy" {
  count = var.image_signing_pipeline_role_arn != "" ? 1 : 0

  statement {
    sid    = "PipelinePushesImages"
    effect = "Allow"
    actions = [
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
      "ecr:BatchCheckLayerAvailability",
      "ecr:PutImage",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
    ]

    principals {
      type        = "AWS"
      identifiers = [var.image_signing_pipeline_role_arn]
    }
  }

  statement {
    sid       = "ClusterPullsImages"
    effect    = "Allow"
    actions   = ["ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage", "ecr:BatchCheckLayerAvailability"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:PrincipalAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

data "aws_caller_identity" "current" {}

resource "aws_ecr_repository_policy" "this" {
  for_each   = var.image_signing_pipeline_role_arn != "" ? aws_ecr_repository.this : {}
  repository = each.value.name
  policy     = data.aws_iam_policy_document.repository_policy[0].json
}
