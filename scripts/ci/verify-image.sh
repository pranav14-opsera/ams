#!/usr/bin/env bash
# Verifies an image's cosign signature and attestation before the deploy
# stage runs any Helm upgrade / kubectl apply (WO-012). This is a second,
# independent check on top of Kyverno's cluster-side admission control —
# a deploy step that never even reaches the cluster with a bad image is
# strictly better than relying on the admission webhook alone.
set -euo pipefail

: "${IMAGE_REF:?IMAGE_REF is required}"
: "${KMS_KEY_ALIAS:?KMS_KEY_ALIAS is required}"
EXPECTED_GIT_SHA="${EXPECTED_GIT_SHA:-}"

KEY_REF="awskms:///${KMS_KEY_ALIAS}"

echo "Verifying signature for ${IMAGE_REF}"
if ! cosign verify --key "$KEY_REF" "$IMAGE_REF" > /dev/null 2>&1; then
  echo "REJECTED: signature verification failed for ${IMAGE_REF} against ${KEY_REF}." >&2
  exit 1
fi

echo "Verifying attestation for ${IMAGE_REF}"
attestation_json=$(cosign verify-attestation --key "$KEY_REF" --type custom "$IMAGE_REF" 2>/dev/null | tail -1) || {
  echo "REJECTED: attestation verification failed for ${IMAGE_REF}." >&2
  exit 1
}

# cosign verify-attestation prints a DSSE envelope; the predicate itself is
# base64-encoded inside .payload, which decodes to an in-toto Statement.
# For --type custom specifically, cosign wraps whatever predicate file was
# given as a STRING under .predicate.Data (plus a .predicate.Timestamp it
# adds itself) — it is NOT the raw predicate JSON's fields directly under
# .predicate. Confirmed by decoding a real attestation bundle rather than
# assuming the shape from cosign's docs.
#
# Each stage is captured into its own variable rather than chained in one
# long pipe: some base64 implementations report a non-zero exit for
# trailing bytes even after decoding correctly, which under `pipefail`
# would abort the whole pipeline despite jq downstream getting valid JSON.
# The real correctness signal is whether the final jq parse succeeds, not
# whether every intermediate tool's own exit code was zero.
encoded_payload=$(echo "$attestation_json" | jq -r '.payload')
statement_json=$(echo "$encoded_payload" | base64 -d 2>/dev/null) || true
predicate=$(echo "$statement_json" | jq -r '.predicate.Data')

if [ -z "$predicate" ] || [ "$predicate" = "null" ]; then
  echo "REJECTED: could not extract a predicate from the attestation for ${IMAGE_REF}." >&2
  exit 1
fi

if [ -n "$EXPECTED_GIT_SHA" ]; then
  actual_sha=$(echo "$predicate" | jq -r '.gitSha')
  if [ "$actual_sha" != "$EXPECTED_GIT_SHA" ]; then
    echo "REJECTED: attestation gitSha ($actual_sha) does not match the commit being deployed ($EXPECTED_GIT_SHA)." >&2
    exit 1
  fi
fi

echo "OK: ${IMAGE_REF} signature and attestation verified. Predicate: $predicate"
