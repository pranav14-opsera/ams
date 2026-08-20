import { ConflictException, Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../common/database/database.module";

export interface TeamWithMemberCount {
  id: string;
  name: string;
  memberCount: number;
}

interface TeamRow {
  id: string;
  name: string;
  member_count: string;
}

/**
 * WO-080 Step 3 (Assign Team): backs `GET /api/v1/teams` — this WO's own
 * implementation_steps/api_contracts name that exact route, distinct from
 * WO-075's `GET /api/v1/dashboards/usage/team/teams` (which returns bare
 * `{id, name}`, no member count, and lives under the usage-dashboard
 * module for a different consumer). Rather than reshaping that existing,
 * already-tested endpoint for a second, unrelated caller, this is its own
 * small `teams` module — same `teams`/`team_members` tables, a
 * member-count-bearing query this WO's own AC actually needs ("team name
 * and member count").
 */
@Injectable()
export class TeamsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Every team in the tenant, with member counts — backs the Platform Administrator's team-assignment dropdown (org-scoped caller sees every team). */
  async listForTenant(client: Pool | PoolClient | undefined, tenantId: string): Promise<TeamWithMemberCount[]> {
    const executor = client ?? this.pool;
    const result = await executor.query<TeamRow>(
      `SELECT t.id, t.name, count(tm.user_id) AS member_count
       FROM teams t
       LEFT JOIN team_members tm ON tm.team_id = t.id
       WHERE t.tenant_id = $1
       GROUP BY t.id, t.name
       ORDER BY t.name ASC`,
      [tenantId],
    );
    return result.rows.map((row) => ({ id: row.id, name: row.name, memberCount: Number(row.member_count) }));
  }

  /** Just the teams a specific user belongs to, with member counts — backs a team-scoped caller's own (smaller) selector. */
  async listForUser(client: Pool | PoolClient | undefined, tenantId: string, userId: string): Promise<TeamWithMemberCount[]> {
    const executor = client ?? this.pool;
    const result = await executor.query<TeamRow>(
      `SELECT t.id, t.name, count(tm2.user_id) AS member_count
       FROM teams t
       JOIN team_members tm ON tm.team_id = t.id AND tm.tenant_id = $1 AND tm.user_id = $2
       LEFT JOIN team_members tm2 ON tm2.team_id = t.id
       WHERE t.tenant_id = $1
       GROUP BY t.id, t.name
       ORDER BY t.name ASC`,
      [tenantId, userId],
    );
    return result.rows.map((row) => ({ id: row.id, name: row.name, memberCount: Number(row.member_count) }));
  }

  /**
   * AC (WO-080 Step 3): "with the option to create a new team if the user
   * has Admin role." `teams` has a `UNIQUE (tenant_id, name)` constraint
   * (migration 003) — a duplicate name is surfaced as a 409, same
   * "translate the DB's own uniqueness guarantee into a clear error"
   * convention as AgentsService.create's own duplicate-name check, just
   * caught from the constraint itself (a single INSERT) rather than a
   * separate SELECT-then-INSERT (no concurrent-creation race either way).
   */
  async create(client: Pool | PoolClient | undefined, tenantId: string, actorId: string | null, name: string): Promise<TeamWithMemberCount> {
    const executor = client ?? this.pool;
    try {
      const result = await executor.query<{ id: string; name: string }>(
        "INSERT INTO teams (tenant_id, name, created_by) VALUES ($1, $2, $3) RETURNING id, name",
        [tenantId, name, actorId],
      );
      const row = result.rows[0]!;
      return { id: row.id, name: row.name, memberCount: 0 };
    } catch (err) {
      // Postgres unique_violation.
      if ((err as { code?: string }).code === "23505") {
        throw new ConflictException(`A team named "${name}" already exists for this tenant.`);
      }
      throw err;
    }
  }
}
