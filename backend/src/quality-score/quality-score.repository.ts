import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../common/database/database.module";
import type { QualityScoreBaseline, QualityScoreConfig, QualityScoreHistoryEntry } from "./quality-score.types";
import type { QualityScoreResult } from "../algorithms/quality-score";

interface ConfigRow {
  id: string;
  tenant_id: string;
  tool_call_weight: number;
  reasoning_weight: number;
  consistency_weight: number;
}

interface HistoryRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  computed_at: Date;
  tool_call_score: string | null;
  reasoning_score: string | null;
  consistency_score: string | null;
  composite_score: string | null;
  sample_count: number;
}

interface BaselineRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  baseline_score: string | null;
  calibration_started_at: Date;
  established_at: Date | null;
}

function toConfigDomain(row: ConfigRow): QualityScoreConfig {
  return { id: row.id, tenantId: row.tenant_id, toolCallWeight: row.tool_call_weight, reasoningWeight: row.reasoning_weight, consistencyWeight: row.consistency_weight };
}

function toHistoryDomain(row: HistoryRow): QualityScoreHistoryEntry {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    computedAt: row.computed_at,
    toolCallScore: row.tool_call_score === null ? null : Number(row.tool_call_score),
    reasoningScore: row.reasoning_score === null ? null : Number(row.reasoning_score),
    consistencyScore: row.consistency_score === null ? null : Number(row.consistency_score),
    compositeScore: row.composite_score === null ? null : Number(row.composite_score),
    sampleCount: row.sample_count,
  };
}

function toBaselineDomain(row: BaselineRow): QualityScoreBaseline {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    baselineScore: row.baseline_score === null ? null : Number(row.baseline_score),
    calibrationStartedAt: row.calibration_started_at,
    establishedAt: row.established_at,
  };
}

@Injectable()
export class QualityScoreRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  // --- Component data sources -------------------------------------------------

  /** Avg of raw tool_call_success samples over the window — same raw-table granularity as reasoning/consistency below (not the 1hr materialized aggregate), so all 3 components reflect the identical time window. */
  async getToolCallSuccessRate(client: Pool | PoolClient | undefined, tenantId: string, agentId: string, sinceIso: string): Promise<number | null> {
    const executor = client ?? this.pool;
    const result = await executor.query<{ avg: string | null }>(
      "SELECT avg(value) AS avg FROM agent_metrics WHERE tenant_id = $1 AND agent_id = $2 AND metric_name = 'tool_call_success' AND recorded_at >= $3",
      [tenantId, agentId, sinceIso],
    );
    const avg = result.rows[0]?.avg;
    return avg === null || avg === undefined ? null : Number(avg);
  }

  /** Proxy for "reasoning accuracy": trace-level completion rate (completed / (completed+failed)) — this platform has no LLM-judge/ground-truth semantic-accuracy mechanism, so a trace reaching 'completed' rather than 'failed' is the best real signal available for "the agent's reasoning got it to a valid conclusion." */
  async getReasoningAccuracy(client: Pool | PoolClient | undefined, tenantId: string, agentId: string, sinceIso: string): Promise<number | null> {
    const executor = client ?? this.pool;
    const result = await executor.query<{ status: "completed" | "failed"; count: string }>(
      "SELECT status, count(*) AS count FROM agent_execution_traces WHERE tenant_id = $1 AND agent_id = $2 AND started_at >= $3 AND status IN ('completed', 'failed') GROUP BY status",
      [tenantId, agentId, sinceIso],
    );
    let completed = 0;
    let failed = 0;
    for (const row of result.rows) {
      if (row.status === "completed") completed = Number(row.count);
      else failed = Number(row.count);
    }
    const total = completed + failed;
    return total === 0 ? null : completed / total;
  }

  /**
   * Proxy for "output consistency": 1 minus the coefficient of variation
   * (stddev/mean) of per-step duration across all traces in the window,
   * clamped to [0, 1]. This platform has no output-content
   * similarity/embedding infrastructure to compare actual outputs
   * semantically, so a stable step-duration profile — the agent behaving
   * the same way run to run rather than erratically fast/slow — is the
   * best real, existing signal for behavioral consistency. Requires at
   * least 2 duration samples to compute a variance at all.
   */
  async getOutputConsistency(client: Pool | PoolClient | undefined, tenantId: string, agentId: string, sinceIso: string): Promise<number | null> {
    const executor = client ?? this.pool;
    const result = await executor.query<{ mean: string | null; stddev: string | null; n: string }>(
      `SELECT avg((elem->>'durationMs')::numeric) AS mean, stddev_samp((elem->>'durationMs')::numeric) AS stddev, count(*) AS n
       FROM agent_execution_traces t, jsonb_array_elements(t.steps) elem
       WHERE t.tenant_id = $1 AND t.agent_id = $2 AND t.started_at >= $3 AND elem->>'durationMs' IS NOT NULL`,
      [tenantId, agentId, sinceIso],
    );
    const row = result.rows[0];
    const n = Number(row?.n ?? 0);
    if (n < 2) return null;
    const mean = Number(row!.mean);
    if (mean <= 0) return null;
    const stddev = Number(row!.stddev ?? 0);
    const coefficientOfVariation = stddev / mean;
    return Math.max(0, Math.min(1, 1 - coefficientOfVariation));
  }

  // --- Config ------------------------------------------------------------------

  async getConfig(client: Pool | PoolClient | undefined, tenantId: string): Promise<QualityScoreConfig | null> {
    const executor = client ?? this.pool;
    const result = await executor.query<ConfigRow>("SELECT * FROM quality_score_configs WHERE tenant_id = $1", [tenantId]);
    return result.rows[0] ? toConfigDomain(result.rows[0]) : null;
  }

  async upsertConfig(client: Pool | PoolClient | undefined, tenantId: string, toolCallWeight: number, reasoningWeight: number, consistencyWeight: number): Promise<QualityScoreConfig> {
    const executor = client ?? this.pool;
    const result = await executor.query<ConfigRow>(
      `INSERT INTO quality_score_configs (tenant_id, tool_call_weight, reasoning_weight, consistency_weight)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id) DO UPDATE SET tool_call_weight = $2, reasoning_weight = $3, consistency_weight = $4, updated_at = now()
       RETURNING *`,
      [tenantId, toolCallWeight, reasoningWeight, consistencyWeight],
    );
    return toConfigDomain(result.rows[0]);
  }

  // --- History -------------------------------------------------------------

  async storeScore(client: Pool | PoolClient | undefined, tenantId: string, agentId: string, result: QualityScoreResult, computedAt: Date): Promise<QualityScoreHistoryEntry> {
    const executor = client ?? this.pool;
    const inserted = await executor.query<HistoryRow>(
      `INSERT INTO quality_score_history (tenant_id, agent_id, computed_at, tool_call_score, reasoning_score, consistency_score, composite_score, sample_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [tenantId, agentId, computedAt, result.componentScores.toolCall, result.componentScores.reasoning, result.componentScores.consistency, result.compositeScore, result.sampleCount],
    );
    return toHistoryDomain(inserted.rows[0]);
  }

  async getScoreHistory(client: Pool | PoolClient | undefined, tenantId: string, agentId: string, sinceIso: string): Promise<QualityScoreHistoryEntry[]> {
    const executor = client ?? this.pool;
    const result = await executor.query<HistoryRow>(
      "SELECT * FROM quality_score_history WHERE tenant_id = $1 AND agent_id = $2 AND computed_at >= $3 ORDER BY computed_at ASC",
      [tenantId, agentId, sinceIso],
    );
    return result.rows.map(toHistoryDomain);
  }

  async getMostRecentScore(client: Pool | PoolClient | undefined, tenantId: string, agentId: string): Promise<QualityScoreHistoryEntry | null> {
    const executor = client ?? this.pool;
    const result = await executor.query<HistoryRow>("SELECT * FROM quality_score_history WHERE tenant_id = $1 AND agent_id = $2 ORDER BY computed_at DESC LIMIT 1", [tenantId, agentId]);
    return result.rows[0] ? toHistoryDomain(result.rows[0]) : null;
  }

  /** Median composite score over the calibration window — the AC's own choice of statistic for baseline establishment (more resistant to a handful of noisy 5-minute ticks than a mean). */
  async getMedianScoreSince(client: Pool | PoolClient | undefined, tenantId: string, agentId: string, sinceIso: string): Promise<{ median: number | null; sampleCount: number }> {
    const executor = client ?? this.pool;
    const result = await executor.query<{ median: string | null; sample_count: string }>(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY composite_score) AS median, count(composite_score) AS sample_count
       FROM quality_score_history
       WHERE tenant_id = $1 AND agent_id = $2 AND computed_at >= $3 AND composite_score IS NOT NULL`,
      [tenantId, agentId, sinceIso],
    );
    const row = result.rows[0];
    return { median: row?.median === null || row?.median === undefined ? null : Number(row.median), sampleCount: Number(row?.sample_count ?? 0) };
  }

  // --- Baseline ------------------------------------------------------------

  async ensureBaselineStarted(client: Pool | PoolClient | undefined, tenantId: string, agentId: string): Promise<QualityScoreBaseline> {
    const executor = client ?? this.pool;
    const result = await executor.query<BaselineRow>(
      `INSERT INTO quality_score_baselines (tenant_id, agent_id)
       VALUES ($1, $2)
       ON CONFLICT (tenant_id, agent_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id
       RETURNING *`,
      [tenantId, agentId],
    );
    return toBaselineDomain(result.rows[0]);
  }

  async findBaseline(client: Pool | PoolClient | undefined, tenantId: string, agentId: string): Promise<QualityScoreBaseline | null> {
    const executor = client ?? this.pool;
    const result = await executor.query<BaselineRow>("SELECT * FROM quality_score_baselines WHERE tenant_id = $1 AND agent_id = $2", [tenantId, agentId]);
    return result.rows[0] ? toBaselineDomain(result.rows[0]) : null;
  }

  async establishBaseline(client: Pool | PoolClient | undefined, tenantId: string, agentId: string, baselineScore: number): Promise<QualityScoreBaseline> {
    const executor = client ?? this.pool;
    const result = await executor.query<BaselineRow>(
      "UPDATE quality_score_baselines SET baseline_score = $3, established_at = now(), updated_at = now() WHERE tenant_id = $1 AND agent_id = $2 RETURNING *",
      [tenantId, agentId, baselineScore],
    );
    return toBaselineDomain(result.rows[0]);
  }

  // --- Fleet iteration for the scheduler ------------------------------------

  async findDistinctTenantIdsWithActiveAgents(client?: Pool | PoolClient): Promise<string[]> {
    const executor = client ?? this.pool;
    const result = await executor.query<{ tenant_id: string }>("SELECT DISTINCT tenant_id FROM agents WHERE lifecycle_status IN ('active', 'connecting')");
    return result.rows.map((row) => row.tenant_id);
  }

  async findActiveAgentIds(client: Pool | PoolClient | undefined, tenantId: string): Promise<string[]> {
    const executor = client ?? this.pool;
    const result = await executor.query<{ id: string }>("SELECT id FROM agents WHERE tenant_id = $1 AND lifecycle_status IN ('active', 'connecting')", [tenantId]);
    return result.rows.map((row) => row.id);
  }
}
