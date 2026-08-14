# Container image signing key (WO-012). cosign signs every image after all
# five security scans pass (WO-008) and before it's available for
# deployment, using this key via its native `awskms://` provider — the
# private key material never leaves KMS, cosign only ever calls
# kms:Sign/kms:GetPublicKey over the API.
#
# ECC_NIST_P256 (not RSA): cosign's default and recommended spec for KMS
# keys — smaller signatures, faster verification, and it's what Kyverno's
# KMS-backed imageVerify policies expect out of the box.

data "aws_iam_policy_document" "image_signing_key" {
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

  # Only the pipeline's own role signs — a compromised application
  # workload or a developer's personal AWS credentials must never be able
  # to mint a valid signature for an image that hasn't been through the
  # scan gate.
  dynamic "statement" {
    for_each = var.image_signing_pipeline_role_arn != "" ? [1] : []
    content {
      sid       = "PipelineSignsImages"
      effect    = "Allow"
      actions   = ["kms:Sign", "kms:GetPublicKey", "kms:DescribeKey"]
      resources = ["*"]

      principals {
        type        = "AWS"
        identifiers = [var.image_signing_pipeline_role_arn]
      }
    }
  }

  # Verification (Kyverno's admission webhook, the deploy stage's own
  # verify-image.sh, any developer running `cosign verify` locally) only
  # ever needs the public key — never Sign.
  statement {
    sid       = "AnyoneVerifies"
    effect    = "Allow"
    actions   = ["kms:GetPublicKey", "kms:DescribeKey"]
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

resource "aws_kms_key" "image_signing" {
  description              = "${var.name_prefix}-${var.environment} container image signing key (cosign, WO-012)"
  key_usage                = "SIGN_VERIFY"
  customer_master_key_spec = "ECC_NIST_P256"
  deletion_window_in_days  = 30
  enable_key_rotation      = false # AWS KMS doesn't support automatic rotation for asymmetric keys — see the rotation procedure documented below
  policy                   = data.aws_iam_policy_document.image_signing_key.json

  tags = merge(local.common_tags, {
    Name    = "${var.name_prefix}-${var.environment}-image-signing"
    Purpose = "container-image-signing"
  })
}

resource "aws_kms_alias" "image_signing" {
  name          = "alias/${var.name_prefix}-${var.environment}-image-signing"
  target_key_id = aws_kms_key.image_signing.key_id
}

# Key rotation procedure (documented here since there's no automated
# rotation Lambda for this key — unlike jwt-signing.tf, image signatures
# aren't bearer tokens with a short natural lifetime, so a fixed rotation
# schedule isn't the right model; rotate on suspected compromise or a
# yearly cadence instead):
#
# 1. Provision a new `aws_kms_key.image_signing_v2` (bump the resource
#    name) alongside this one — do NOT delete or disable the old key yet.
# 2. Update scripts/ci/sign-image.sh to sign new images with the v2 key's
#    alias. Every image built from this point forward is signed by v2.
# 3. Update the Kyverno ClusterPolicy
#    (infrastructure/kubernetes/admission/cosign-policy.yaml) to accept
#    EITHER the v1 or v2 public key during the overlap window (Kyverno
#    supports multiple attestor entries in one policy).
# 4. Keep v1 active for 30 days — any already-deployed pod running an
#    image signed under v1 must still pass admission control if it's
#    rescheduled (node drain, HPA scale-up, etc.) during that window.
# 5. After 30 days, confirm no running pod's image was signed under v1
#    (query Kyverno's policy reports), remove v1 from the ClusterPolicy's
#    attestor list, then schedule v1's KMS key for deletion.
