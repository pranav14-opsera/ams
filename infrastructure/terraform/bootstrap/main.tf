# One-time bootstrap for Terraform remote state: an encrypted, versioned S3
# bucket plus a DynamoDB lock table. This module is applied once with local
# state (there is nowhere else for its own state to live before the bucket
# exists), then every other module in infrastructure/terraform/ points its
# S3 backend config at the bucket/table created here.

terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.100"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.9"
    }
  }
}

provider "aws" {
  region = var.region
}

variable "region" {
  description = "AWS region for the state bucket and lock table."
  type        = string
}

variable "name_prefix" {
  description = "Prefix applied to the bucket/table names, e.g. 'ams'."
  type        = string
  default     = "ams"
}

resource "random_id" "suffix" {
  byte_length = 4
}

#checkov:skip=CKV_AWS_18:this bucket only ever holds Terraform state, read by the small number of operators who already have account access — a dedicated access-log bucket adds a second bootstrap resource for marginal benefit here
#checkov:skip=CKV_AWS_144:single-region state bucket is intentional for this account; state is recreatable from the source-controlled .tf files if the region is ever lost, unlike primary application data
#checkov:skip=CKV_AWS_145:AES256 (SSE-S3) is deliberate here, not KMS — this is the bootstrap module that runs before any KMS key exists in the account, so a KMS-encrypted bucket would be a chicken-and-egg dependency
#checkov:skip=CKV2_AWS_62:event notifications aren't meaningful for a state bucket with a handful of human operators; DynamoDB locking is the concurrency control that matters here
resource "aws_s3_bucket" "state" {
  bucket = "${var.name_prefix}-terraform-state-${random_id.suffix.hex}"

  tags = {
    Project   = var.name_prefix
    ManagedBy = "terraform"
    Purpose   = "terraform-remote-state"
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}

# Non-current versions accumulate on every terraform apply (versioning is
# required for state recovery); expire them after 90 days instead of
# keeping every historical state version forever.
resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    id     = "expire-noncurrent-state-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 90
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

#checkov:skip=CKV_AWS_119:AWS-owned key (server_side_encryption.enabled) is deliberate — same bootstrap chicken-and-egg reasoning as the state bucket's AES256 choice: no KMS key exists yet when this module first runs
resource "aws_dynamodb_table" "lock" {
  name         = "${var.name_prefix}-terraform-locks"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }

  tags = {
    Project   = var.name_prefix
    ManagedBy = "terraform"
    Purpose   = "terraform-remote-state-lock"
  }
}

output "state_bucket_name" {
  value = aws_s3_bucket.state.id
}

output "lock_table_name" {
  value = aws_dynamodb_table.lock.name
}
