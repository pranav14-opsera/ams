import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../common/database/database.module";
import type { AgentExecutionTrace, TraceStatus, TraceStep } from "./trace.types";

export interface TraceFilters {
  status?: TraceStatus;
  limit: number;
  offset: number;
}

interface TraceDbRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  status: TraceStatus;
  started_at: Date;
  duration_ms: number | null;
  steps: TraceStep[];
}

function toDomain(row: TraceDbRow): AgentExecutionTrace {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    agentId: row.agent_id,
    status: row.status,
    startedAt: row.started_at,
    durationMs: row.duration_ms,
    steps: row.steps,
  };
}

@Injectable()
export class TraceRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async findByAgentId(client: Pool | PoolClient | undefined, tenantId: string, agentId: string, filters: TraceFilters): Promise<{ rows: AgentExecutionTrace[]; total: number }> {
    const executor = client ?? this.pool;
    const conditions = ["tenant_id = $1", "agent_id = $2"];
    const params: unknown[] = [tenantId, agentId];

    if (filters.status) {
      params.push(filters.status);
      conditions.push(`status = $${params.length}`);
    }

    const whereClause = conditions.join(" AND ");
    const countResult = await executor.query<{ count: string }>(`SELECT count(*) FROM agent_execution_traces WHERE ${whereClause}`, params);

    const rows = await executor.query<TraceDbRow>(
      `SELECT id, tenant_id, agent_id, status, started_at, duration_ms, steps
       FROM agent_execution_traces
       WHERE ${whereClause}
       ORDER BY started_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filters.limit, filters.offset],
    );

    return { total: Number(countResult.rows[0].count), rows: rows.rows.map(toDomain) };
  }

  async create(
    client: Pool | PoolClient | undefined,
    tenantId: string,
    agentId: string,
    fields: { status: TraceStatus; startedAt: Date; durationMs: number | null; steps: TraceStep[] },
  ): Promise<AgentExecutionTrace> {
    const executor = client ?? this.pool;
    const result = await executor.query<TraceDbRow>(
      `INSERT INTO agent_execution_traces (tenant_id, agent_id, status, started_at, duration_ms, steps)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, tenant_id, agent_id, status, started_at, duration_ms, steps`,
      [tenantId, agentId, fields.status, fields.startedAt, fields.durationMs, JSON.stringify(fields.steps)],
    );
    return toDomain(result.rows[0]);
  }
}
