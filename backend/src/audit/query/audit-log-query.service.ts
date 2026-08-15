import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../../common/database/database.module";
import { PermissionName } from "../../rbac/rbac.constants";
import type { AuditLogPage } from "./audit-log-query.repository";
import { AuditLogQueryRepository } from "./audit-log-query.repository";
import type { AuditLogQueryDto } from "./dto/audit-log-query.dto";

const DEFAULT_PAGE_LIMIT = 100;

export interface AuditLogCallerContext {
  tenantId: string;
  actorId: string;
  permissions: string[];
}

/**
 * WO-047's RBAC scoping decision layer, sitting ABOVE RbacGuard's own
 * gate (which only proves the caller holds view_org OR view_team — see
 * @RequireAnyPermission on AuditLogController). This resolves WHICH of
 * the two the caller actually has, and for view_team-only callers
 * (team_lead), narrows the query to their own team's members' actor_ids
 * — the audit_events table itself has no team_id column, so this is
 * done by resolving team membership first, then filtering by actor_id,
 * rather than a join the schema doesn't support.
 */
@Injectable()
export class AuditLogQueryService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly repository: AuditLogQueryRepository,
  ) {}

  async query(caller: AuditLogCallerContext, dto: AuditLogQueryDto, client?: PoolClient): Promise<AuditLogPage & { restrictedToTeamScope: boolean }> {
    const restrictToActorIds = caller.permissions.includes(PermissionName.AUDIT_LOGS_VIEW_ORG) ? undefined : await this.resolveTeamMemberActorIds(caller.tenantId, caller.actorId, client);

    const page = await this.repository.findByFilters(
      {
        tenantId: caller.tenantId,
        startTime: new Date(dto.startTime),
        endTime: new Date(dto.endTime),
        actorId: dto.actorId,
        action: dto.action,
        resourceType: dto.resourceType,
        resourceId: dto.resourceId,
        dataClassification: dto.dataClassification,
        correlationId: dto.correlationId,
        restrictToActorIds,
      },
      dto.limit ?? DEFAULT_PAGE_LIMIT,
      dto.cursor ?? null,
      client,
    );

    return { ...page, restrictedToTeamScope: restrictToActorIds !== undefined };
  }

  /** All user ids belonging to any team the caller themselves belongs to — a team_lead's "team scope" is every member of their own team(s), not just themselves. */
  private async resolveTeamMemberActorIds(tenantId: string, callerActorId: string, client?: PoolClient): Promise<string[]> {
    const executor = client ?? this.pool;
    const teamIds = await executor.query("SELECT team_id FROM team_members WHERE tenant_id = $1 AND user_id = $2", [tenantId, callerActorId]);
    if (teamIds.rows.length === 0) return [callerActorId]; // not on any team: scoped to just their own actions

    const memberIds = await executor.query(
      "SELECT DISTINCT user_id FROM team_members WHERE tenant_id = $1 AND team_id = ANY($2)",
      [tenantId, teamIds.rows.map((r: { team_id: string }) => r.team_id)],
    );
    return memberIds.rows.map((r: { user_id: string }) => r.user_id);
  }
}
