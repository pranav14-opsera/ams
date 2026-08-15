import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../common/database/database.module";
import type { AgentLifecycleStatus } from "./dto/list-agents-query.dto";

export interface AgentStateTransitionRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  from_status: AgentLifecycleStatus;
  to_status: AgentLifecycleStatus;
  reason: string | null;
  triggered_by: string | null;
  warning_flag: boolean;
  incomplete_operations_count: number | null;
  occurred_at: Date;
}

export interface RecordTransitionInput {
  tenantId: string;
  agentId: string;
  fromStatus: AgentLifecycleStatus;
  toStatus: AgentLifecycleStatus;
  justification: string | null;
  actorId: string | null;
  warningFlag: boolean;
  incompleteOperationsCount: number | null;
}

// Table itself predates this WO (migration 009) — column names
// (from_status/to_status/reason/triggered_by) are the pre-existing
// schema, not renamed to match this WO's AC wording 1:1.
@Injectable()
export class AgentStateTransitionsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async record(client: Pool | PoolClient | undefined, input: RecordTransitionInput): Promise<AgentStateTransitionRow> {
    const executor = client ?? this.pool;
    const result = await executor.query<AgentStateTransitionRow>(
      `INSERT INTO agent_state_transitions (tenant_id, agent_id, from_status, to_status, reason, triggered_by, warning_flag, incomplete_operations_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        input.tenantId,
        input.agentId,
        input.fromStatus,
        input.toStatus,
        input.justification,
        input.actorId,
        input.warningFlag,
        input.incompleteOperationsCount,
      ],
    );
    return result.rows[0];
  }

  async findByAgentId(client: Pool | PoolClient | undefined, tenantId: string, agentId: string): Promise<AgentStateTransitionRow[]> {
    const executor = client ?? this.pool;
    const result = await executor.query<AgentStateTransitionRow>(
      "SELECT * FROM agent_state_transitions WHERE tenant_id = $1 AND agent_id = $2 ORDER BY occurred_at ASC",
      [tenantId, agentId],
    );
    return result.rows;
  }
}
