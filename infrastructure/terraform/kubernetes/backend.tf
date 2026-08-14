# Remote state backend: encrypted S3 bucket + DynamoDB lock table.
#
# Terraform's S3 backend block cannot use variables, so these values are
# supplied at `terraform init -backend-config=...` time (see backend.hcl.example).
# The bucket/table themselves are provisioned by the bootstrap module below,
# which is applied once, out-of-band, before this module's own state can
# live in S3 (a classic chicken-and-egg for remote state — bootstrap runs
# with local state, everything after runs with remote state).

terraform {
  backend "s3" {}
}
