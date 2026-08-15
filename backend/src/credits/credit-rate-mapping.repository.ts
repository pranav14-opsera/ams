import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../common/database/database.module";
import type { CreditRateMapping, TeamCreditLimit } from "./credit-rate-mapping.types";

interface RateRow {
  id: string;
  tenant_id: string;
  action_type: string;
  credits_per_unit: string;
  effective_from: Date;
  effective_until: Date | null;
}

interface LimitRow {
  id: string;
  tenant_id: string;
  team_id: string;
  hard_cap: number | null;
}

function toRateDomain(row: RateRow): CreditRateMapping {
  return { id: row.id, tenantId: row.tenant_id, actionType: row.action_type, creditsPerUnit: Number(row.credits_per_unit), effectiveFrom: row.effective_from, effectiveUntil: row.effective_until };
}

function toLimitDomain(row: LimitRow): TeamCreditLimit {
  return { id: row.id, tenantId: row.tenant_id, teamId: row.team_id, hardCap: row.hard_cap };
}

@Injectable()
export class CreditRateMappingRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** The single currently-effective rate for this tenant+action, or null if none is configured (or none is currently in its effective window). */
  async findEffectiveRate(client: Pool | PoolClient | undefined, tenantId: string, actionType: string, now: Date = new Date()): Promise<CreditRateMapping | null> {
    const executor = client ?? this.pool;
    const result = await executor.query<RateRow>(
      `SELECT * FROM credit_rate_mappings
       WHERE tenant_id = $1 AND action_type = $2 AND effective_from <= $3 AND (effective_until IS NULL OR effective_until > $3)
       ORDER BY effective_from DESC LIMIT 1`,
      [tenantId, actionType, now],
    );
    return result.rows[0] ? toRateDomain(result.rows[0]) : null;
  }

  async upsertRate(client: Pool | PoolClient | undefined, tenantId: string, actionType: string, creditsPerUnit: number, effectiveFrom: Date = new Date()): Promise<CreditRateMapping> {
    const executor = client ?? this.pool;
    const result = await executor.query<RateRow>(
      "INSERT INTO credit_rate_mappings (tenant_id, action_type, credits_per_unit, effective_from) VALUES ($1, $2, $3, $4) RETURNING *",
      [tenantId, actionType, creditsPerUnit, effectiveFrom],
    );
    return toRateDomain(result.rows[0]);
  }

  async findHardCap(client: Pool | PoolClient | undefined, tenantId: string, teamId: string): Promise<TeamCreditLimit | null> {
    const executor = client ?? this.pool;
    const result = await executor.query<LimitRow>("SELECT * FROM team_credit_limits WHERE tenant_id = $1 AND team_id = $2", [tenantId, teamId]);
    return result.rows[0] ? toLimitDomain(result.rows[0]) : null;
  }

  async upsertHardCap(client: Pool | PoolClient | undefined, tenantId: string, teamId: string, hardCap: number | null): Promise<TeamCreditLimit> {
    const executor = client ?? this.pool;
    const result = await executor.query<LimitRow>(
      `INSERT INTO team_credit_limits (tenant_id, team_id, hard_cap)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, team_id) DO UPDATE SET hard_cap = $3, updated_at = now()
       RETURNING *`,
      [tenantId, teamId, hardCap],
    );
    return toLimitDomain(result.rows[0]);
  }
}
