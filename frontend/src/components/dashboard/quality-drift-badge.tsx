import { Badge } from "@/components/ui/badge";
import type { DriftStatus } from "@/types/dashboard";

const DRIFT_LABEL: Record<DriftStatus, string> = {
  stable: "Stable",
  drifting_up: "Drifting (degrading)",
  drifting_down: "Drifting (improving)",
  insufficient_data: "Insufficient data",
};

const DRIFT_VARIANT: Record<DriftStatus, "active" | "degraded" | "neutral"> = {
  stable: "active",
  drifting_up: "degraded",
  drifting_down: "active",
  insufficient_data: "neutral",
};

/** AC: current quality score and drift detection status. Both are a lightweight heuristic computed in DashboardService/quality-score.util.ts, not a full anomaly-detection system (that's WO-061's own scope) — displayed as-is here. */
export function QualityDriftBadge({ qualityScore, driftStatus }: { qualityScore: number | null; driftStatus: DriftStatus }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm">
        Quality score: <span className="font-medium">{qualityScore === null ? "—" : qualityScore}</span>
      </span>
      <Badge variant={DRIFT_VARIANT[driftStatus]}>{DRIFT_LABEL[driftStatus]}</Badge>
    </div>
  );
}
