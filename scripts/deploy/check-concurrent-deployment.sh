#!/usr/bin/env bash
# Concurrent-deployment guard (WO-010): rejects a new production rollout if
# one is already mid-canary. A second rollout starting on top of an
# in-progress one would leave Argo Rollouts juggling two ReplicaSet
# transitions against the same Service — reject outright so a stuck
# deployment is visibly stuck, not silently queued behind another.
set -euo pipefail

NAMESPACE="${1:?usage: check-concurrent-deployment.sh <namespace> <rollout-name>}"
ROLLOUT="${2:?usage: check-concurrent-deployment.sh <namespace> <rollout-name>}"

phase=$(kubectl argo rollouts status "$ROLLOUT" -n "$NAMESPACE" --timeout 5s 2>/dev/null | tail -1 || echo "NotFound")

case "$phase" in
  *Progressing*|*Paused*)
    echo "REJECTED: rollout '$ROLLOUT' in namespace '$NAMESPACE' is already in progress (status: $phase)." >&2
    exit 1
    ;;
  *)
    echo "OK: no in-progress rollout for '$ROLLOUT' in namespace '$NAMESPACE'."
    exit 0
    ;;
esac
