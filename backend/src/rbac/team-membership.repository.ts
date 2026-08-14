import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import { PG_POOL } from "../common/database/database.module";

@Injectable()
export class TeamMembershipRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async getUserTeamIds(tenantId: string, userId: string): Promise<string[]> {
    const result = await this.pool.query<{ team_id: string }>("SELECT team_id FROM team_members WHERE tenant_id = $1 AND user_id = $2", [tenantId, userId]);
    return result.rows.map((r) => r.team_id);
  }
}
