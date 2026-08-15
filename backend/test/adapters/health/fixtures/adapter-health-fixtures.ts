import type { Pool } from "pg";

/**
 * Seeds a realistic health-check history for one adapter type showing a
 * healthy -> degraded -> recovery pattern (this WO's own fixture
 * requirement) — 5 healthy checks, then 3 consecutive failures
 * (triggering degraded), then 2 more healthy checks (recovery).
 */
export async function seedHealthCheckHistory(pool: Pool, adapterType: string): Promise<void> {
  const pattern: Array<{ status: "healthy" | "unhealthy"; responseTimeMs: number | null; error: string | null }> = [
    { status: "healthy", responseTimeMs: 45, error: null },
    { status: "healthy", responseTimeMs: 50, error: null },
    { status: "healthy", responseTimeMs: 48, error: null },
    { status: "healthy", responseTimeMs: 52, error: null },
    { status: "healthy", responseTimeMs: 47, error: null },
    { status: "unhealthy", responseTimeMs: null, error: "connection timeout" },
    { status: "unhealthy", responseTimeMs: null, error: "connection timeout" },
    { status: "unhealthy", responseTimeMs: null, error: "connection refused" },
    { status: "healthy", responseTimeMs: 60, error: null },
    { status: "healthy", responseTimeMs: 55, error: null },
  ];

  for (const entry of pattern) {
    await pool.query("INSERT INTO adapter_health_checks (adapter_type, status, response_time_ms, error_details) VALUES ($1, $2, $3, $4)", [
      adapterType,
      entry.status,
      entry.responseTimeMs,
      entry.error,
    ]);
  }
}
