#!/usr/bin/env bash
# Signs a container image with cosign after it has passed all five
# security scans (WO-008), attaching an attestation with git SHA, pipeline
# run ID, and scan-pass timestamp (WO-012 acceptance criteria). Signs
# against a KMS key — cosign never touches private key material, it only
# calls kms:Sign over the AWS API.
set -euo pipefail

: "${IMAGE_REF:?IMAGE_REF is required (e.g. 123456789012.dkr.ecr.us-east-1.amazonaws.com/ams-backend@sha256:...)}"
: "${KMS_KEY_ALIAS:?KMS_KEY_ALIAS is required (e.g. alias/ams-prod-image-signing)}"
: "${GIT_SHA:?GIT_SHA is required}"
: "${PIPELINE_RUN_ID:?PIPELINE_RUN_ID is required}"

SCAN_PASS_TIMESTAMP="${SCAN_PASS_TIMESTAMP:?SCAN_PASS_TIMESTAMP is required (ISO-8601, when the last scan-stage check passed)}"
SIGNED_AT="${SIGNED_AT:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"

KEY_REF="awskms:///${KMS_KEY_ALIAS}"

echo "Signing ${IMAGE_REF} with ${KEY_REF}"
cosign sign --key "$KEY_REF" --yes "$IMAGE_REF"

PREDICATE_FILE=$(mktemp)
trap 'rm -f "$PREDICATE_FILE"' EXIT
cat > "$PREDICATE_FILE" <<EOF
{
  "gitSha": "${GIT_SHA}",
  "pipelineRunId": "${PIPELINE_RUN_ID}",
  "scanPassTimestamp": "${SCAN_PASS_TIMESTAMP}",
  "signedAt": "${SIGNED_AT}",
  "signerKeyAlias": "${KMS_KEY_ALIAS}"
}
EOF

echo "Attesting ${IMAGE_REF}"
cosign attest --key "$KEY_REF" --yes --type custom --predicate "$PREDICATE_FILE" "$IMAGE_REF"

echo "OK: signed and attested ${IMAGE_REF}"
