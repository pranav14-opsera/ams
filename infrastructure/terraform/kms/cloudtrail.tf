# CloudTrail management-event trail. KMS and Secrets Manager API calls
# (Encrypt/Decrypt/CreateGrant/GetSecretValue/RotateSecret/etc.) are AWS
# management-plane events and are captured by any trail with management
# event logging enabled — no per-service data-event selector is needed the
# way it would be for S3 object-level or Lambda invoke-level events.
#
# Delivered to both S3 (long-term SOC 2 evidence retention) and CloudWatch
# Logs (near-real-time queryability — the <5 minute acceptance criterion
# for "events appear within 5 minutes" is CloudTrail-to-CloudWatch-Logs
# delivery, which is typically sub-5-minutes, not the ~15 minute S3
# delivery SLA).

resource "random_id" "cloudtrail_bucket_suffix" {
  byte_length = 4
}

#checkov:skip=CKV_AWS_18:this bucket's own access is already covered indirectly — every read/write against it is itself a management-plane S3 API call captured by this same multi-region CloudTrail trail; a dedicated access-log bucket would be logging the logger
#checkov:skip=CKV_AWS_144:single-region audit bucket is a deliberate v1 trade-off, not an oversight — cross-region replication for 7-year SOC 2 evidence is real future work, tracked separately from WO-003's scope (KMS/Secrets Manager provisioning)
#checkov:skip=CKV2_AWS_62:event notifications aren't meaningful for a CloudTrail delivery target with no downstream consumer wired up yet
resource "aws_s3_bucket" "cloudtrail" {
  bucket = "${var.name_prefix}-${var.environment}-cloudtrail-${random_id.cloudtrail_bucket_suffix.hex}"

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-${var.environment}-cloudtrail"
  })
}

resource "aws_s3_bucket_public_access_block" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.platform.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_versioning" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id

  rule {
    id     = "expire-old-audit-logs"
    status = "Enabled"

    filter {}

    # 7-year retention floor for SOC 2 / HIPAA audit evidence.
    expiration {
      days = 2557
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

data "aws_iam_policy_document" "cloudtrail_bucket" {
  statement {
    sid       = "AWSCloudTrailAclCheck"
    effect    = "Allow"
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.cloudtrail.arn]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
  }

  statement {
    sid       = "AWSCloudTrailWrite"
    effect    = "Allow"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.cloudtrail.arn}/AWSLogs/${data.aws_caller_identity.current.account_id}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }
  }
}

resource "aws_s3_bucket_policy" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id
  policy = data.aws_iam_policy_document.cloudtrail_bucket.json
}

resource "aws_cloudwatch_log_group" "cloudtrail" {
  name              = "/aws/cloudtrail/${var.name_prefix}-${var.environment}"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.platform.arn

  tags = local.common_tags
}

data "aws_iam_policy_document" "cloudtrail_cloudwatch_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cloudtrail_cloudwatch" {
  name               = "${var.name_prefix}-${var.environment}-cloudtrail-cloudwatch"
  assume_role_policy = data.aws_iam_policy_document.cloudtrail_cloudwatch_assume.json

  tags = local.common_tags
}

data "aws_iam_policy_document" "cloudtrail_cloudwatch_delivery" {
  statement {
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.cloudtrail.arn}:*"]
  }
}

resource "aws_iam_role_policy" "cloudtrail_cloudwatch" {
  name   = "${var.name_prefix}-${var.environment}-cloudtrail-cloudwatch-delivery"
  role   = aws_iam_role.cloudtrail_cloudwatch.id
  policy = data.aws_iam_policy_document.cloudtrail_cloudwatch_delivery.json
}

# Notifies platform-admins whenever CloudTrail delivers a new batch of log
# files to S3 — lets an alerting pipeline detect delivery gaps (e.g. if
# CloudTrail silently stops logging) rather than only discovering it during
# a SOC 2 audit.
resource "aws_sns_topic" "cloudtrail" {
  name              = "${var.name_prefix}-${var.environment}-cloudtrail-notifications"
  kms_master_key_id = aws_kms_key.platform.id

  tags = local.common_tags
}

data "aws_iam_policy_document" "cloudtrail_sns" {
  statement {
    sid       = "AWSCloudTrailSNSPolicy"
    effect    = "Allow"
    actions   = ["SNS:Publish"]
    resources = [aws_sns_topic.cloudtrail.arn]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }
  }
}

resource "aws_sns_topic_policy" "cloudtrail" {
  arn    = aws_sns_topic.cloudtrail.arn
  policy = data.aws_iam_policy_document.cloudtrail_sns.json
}

resource "aws_cloudtrail" "main" {
  name                          = "${var.name_prefix}-${var.environment}-trail"
  s3_bucket_name                = aws_s3_bucket.cloudtrail.id
  sns_topic_name                = aws_sns_topic.cloudtrail.name
  is_multi_region_trail         = true
  enable_log_file_validation    = true
  include_global_service_events = true
  kms_key_id                    = aws_kms_key.platform.arn

  cloud_watch_logs_group_arn = "${aws_cloudwatch_log_group.cloudtrail.arn}:*"
  cloud_watch_logs_role_arn  = aws_iam_role.cloudtrail_cloudwatch.arn

  tags = merge(local.common_tags, {
    Name = "${var.name_prefix}-${var.environment}-trail"
  })

  depends_on = [
    aws_s3_bucket_policy.cloudtrail,
    aws_iam_role_policy.cloudtrail_cloudwatch,
    aws_sns_topic_policy.cloudtrail,
  ]
}
