import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../../common/database/database.module";
import type { HardCapPauseState } from "./hard-cap-pause-state.types";

interface PauseStateRow {
  id: string;
  tenant_id: string;
  team_id: string;
  agent_id: string;
  paused_at: Date;
}

function toDomain(row: PauseStateRow): HardCapPauseState {
  return { id: row.id, tenantId: row.tenant_id, teamId: row.team_id, agentId: row.agent_id, pausedAt: row.paused_at };
}

@Injectable()
export class HardCapPauseStateRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Idempotent — `ON CONFLICT DO NOTHING` so re-evaluating an already-paused agent (e.g. two overlapping enforcement checks) never errors or creates a second row. */
  async recordPause(client: Pool | PoolClient | undefined, tenantId: string, teamId: string, agentId: string): Promise<void> {
    const executor = client ?? this.pool;
    await executor.query(
      `INSERT INTO hard_cap_pause_state (tenant_id, team_id, agent_id) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, agent_id) DO NOTHING`,
      [tenantId, teamId, agentId],
    );
  }

  async clearPause(client: Pool | PoolClient | undefined, tenantId: string, agentId: string): Promise<void> {
    const executor = client ?? this.pool;
    await executor.query("DELETE FROM hard_cap_pause_state WHERE tenant_id = $1 AND agent_id = $2", [tenantId, agentId]);
  }

  async findPausedForTeam(client: Pool | PoolClient | undefined, tenantId: string, teamId: string): Promise<HardCapPauseState[]> {
    const executor = client ?? this.pool;
    const result = await executor.query<PauseStateRow>("SELECT * FROM hard_cap_pause_state WHERE tenant_id = $1 AND team_id = $2", [tenantId, teamId]);
    return result.rows.map(toDomain);
  }

  /** Distinct (tenant_id, team_id) pairs with at least one currently auto-paused agent — the resume scheduler's own work list, so it never has to scan every tenant/team in the system on every tick. */
  async findDistinctPausedTeams(client: Pool | PoolClient | undefined = undefined): Promise<Array<{ tenantId: string; teamId: string }>> {
    const executor = client ?? this.pool;
    const result = await executor.query<{ tenant_id: string; team_id: string }>("SELECT DISTINCT tenant_id, team_id FROM hard_cap_pause_state");
    return result.rows.map((row) => ({ tenantId: row.tenant_id, teamId: row.team_id }));
  }
}
