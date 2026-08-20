import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../common/database/database.module";

@Injectable()
export class TeamMembershipRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * `team_members` has RLS enabled (migration 006) — its policy is
   * `tenant_id = current_setting('app.current_tenant', true)::uuid`.
   * Calling this against a bare `Pool` (the default when no `client` is
   * passed) checks out a FRESH, unscoped connection per call — same
   * "Pool vs PoolClient" bug class fixed elsewhere in this codebase
   * (e.g. CalibrationService.withTenantScope, CreditTransactionRepository):
   * an unscoped connection's `current_setting` is either NULL (silently
   * returns zero rows, no error) or, if some other code path on that
   * pooled connection ever left `app.current_tenant` set to an empty
   * string, throws `invalid input syntax for type uuid: ""`. Passing the
   * caller's own already-tenant-scoped `client` (e.g. `req.tenantDbClient`,
   * set by TenantContextMiddleware before RbacGuard/any controller ever
   * runs) avoids both failure modes entirely. The optional param keeps
   * every existing unscoped call site (this method predates having a
   * client param at all) working exactly as before.
   */
  async getUserTeamIds(tenantId: string, userId: string, client?: Pool | PoolClient): Promise<string[]> {
    const executor = client ?? this.pool;
    const result = await executor.query<{ team_id: string }>("SELECT team_id FROM team_members WHERE tenant_id = $1 AND user_id = $2", [tenantId, userId]);
    return result.rows.map((r) => r.team_id);
  }
}
