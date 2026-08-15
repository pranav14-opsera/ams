export type DataCategory = "audit_logs" | "execution_traces" | "usage_metrics";

export const DATA_CATEGORIES: DataCategory[] = ["audit_logs", "execution_traces", "usage_metrics"];

interface RetentionBounds {
  minDays: number;
  maxDays: number;
  defaultDays: number;
}

// audit_logs bounds are this WO's own AC: "minimum 1 year per org policy,
// maximum 10 years." execution_traces/usage_metrics bounds are this
// codebase's best-effort extrapolation of the same "sane compliance floor,
// generous ceiling" shape — the AC only specifies audit_logs' bounds
// explicitly. Only audit_logs has real partitioned physical storage to
// tier/purge today (migration 005) — execution_traces and usage_metrics
// have no such table in this codebase yet, so their policies can be
// configured here (this WO's AC requires the config API to accept all
// three categories) but are not yet physically enforced by
// ColdStorageTieringService/RetentionPurgeService. See AUDIT_RETENTION.md.
export const RETENTION_BOUNDS: Record<DataCategory, RetentionBounds> = {
  audit_logs: { minDays: 365, maxDays: 3650, defaultDays: 2555 }, // AC default: 7 years
  execution_traces: { minDays: 1, maxDays: 3650, defaultDays: 90 }, // AC default: 90 days
  usage_metrics: { minDays: 1, maxDays: 3650, defaultDays: 365 }, // AC default: 1 year
};

// AC: "A grace period" — a retention SHORTENING only takes effect 30 days
// after the policy change, so data isn't suddenly eligible for purge the
// instant a shorter policy is saved.
export const RETENTION_SHORTENING_GRACE_PERIOD_DAYS = 30;

// AC: partitions are tiered to cold storage once older than 90 days
// (excluding the current and previous calendar month, so a partition is
// never mid-tiering while still receiving writes).
export const COLD_STORAGE_TIERING_THRESHOLD_DAYS = 90;
