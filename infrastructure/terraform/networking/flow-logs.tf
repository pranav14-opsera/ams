# VPC Flow Logs delivered directly to S3 (no IAM role required for this
# delivery path — AWS's log delivery service writes via the bucket policy
# below) for the network-level audit trail required by security/compliance.

resource "random_id" "flow_log_bucket_suffix" {
  byte_length = 4
}

resource "aws_s3_bucket" "flow_logs" {
  bucket = "${var.name_prefix}-${var.environment}-vpc-flow-logs-${random_id.flow_log_bucket_suffix.hex}"

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-${var.environment}-vpc-flow-logs"
  })
}

resource "aws_s3_bucket_public_access_block" "flow_logs" {
  bucket = aws_s3_bucket.flow_logs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "flow_logs" {
  bucket = aws_s3_bucket.flow_logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "flow_logs" {
  bucket = aws_s3_bucket.flow_logs.id

  rule {
    id     = "expire-flow-logs"
    status = "Enabled"

    filter {}

    expiration {
      days = var.flow_log_retention_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "flow_logs_bucket" {
  statement {
    sid    = "AWSLogDeliveryWrite"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["delivery.logs.amazonaws.com"]
    }

    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.flow_logs.arn}/AWSLogs/${data.aws_caller_identity.current.account_id}/*"]

    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }

  statement {
    sid    = "AWSLogDeliveryAclCheck"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["delivery.logs.amazonaws.com"]
    }

    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.flow_logs.arn]

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_s3_bucket_policy" "flow_logs" {
  bucket = aws_s3_bucket.flow_logs.id
  policy = data.aws_iam_policy_document.flow_logs_bucket.json
}

resource "aws_flow_log" "main" {
  vpc_id                   = aws_vpc.main.id
  log_destination_type     = "s3"
  log_destination          = aws_s3_bucket.flow_logs.arn
  traffic_type             = "ALL"
  max_aggregation_interval = 60

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-${var.environment}-vpc-flow-log"
  })

  depends_on = [aws_s3_bucket_policy.flow_logs]
}
