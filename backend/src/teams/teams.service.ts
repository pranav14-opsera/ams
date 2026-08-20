import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { DataClassification } from "../classification/data-classification.enum";
import { PlatformRoleName } from "../rbac/rbac.constants";
import { AUDIT_SERVICE, type AuditServicePort } from "../tenants/ports/audit-service.port";
import { TeamsRepository, type TeamWithMemberCount } from "./teams.repository";

export interface TeamsActorContext {
  tenantId: string;
  actorId: string | null;
  roles: string[];
}

// Same TEAM_SCOPED_ROLES list as RbacGuard's own (rbac.guard.ts) and
// TeamUsageDashboardService's own — team_lead/agent_operator are the two
// roles this platform ever restricts to "their own team only". Moot for
// this endpoint in practice today (only platform_admin holds
// AGENT_CREATE, the permission this whole module is gated by — see
// TeamsController), but kept so a future role grant doesn't silently leak
// every tenant team to a team-scoped caller.
const TEAM_SCOPED_ROLES: readonly string[] = [PlatformRoleName.TEAM_LEAD, PlatformRoleName.AGENT_OPERATOR];

@Injectable()
export class TeamsService {
  private readonly logger = new Logger(TeamsService.name);

  constructor(
    private readonly repository: TeamsRepository,
    @Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort,
  ) {}

  /** AC (WO-080 Step 3): the team-assignment dropdown's own options — every team in the tenant for an org-scoped caller (Platform Administrator), only the caller's own team(s) otherwise. */
  async list(client: Pool | PoolClient | undefined, ctx: TeamsActorContext): Promise<TeamWithMemberCount[]> {
    const isTeamScopedCaller = ctx.roles.some((role) => TEAM_SCOPED_ROLES.includes(role));
    if (!isTeamScopedCaller) return this.repository.listForTenant(client, ctx.tenantId);
    if (!ctx.actorId) return [];
    return this.repository.listForUser(client, ctx.tenantId, ctx.actorId);
  }

  /** AC (WO-080 Step 3): inline "Create Team" for Admin users, from within the Register Agent wizard. */
  async create(client: Pool | PoolClient | undefined, ctx: TeamsActorContext, name: string): Promise<TeamWithMemberCount> {
    const team = await this.repository.create(client, ctx.tenantId, ctx.actorId, name);

    try {
      await this.auditService.recordEvent({
        tenantId: ctx.tenantId,
        actorId: ctx.actorId,
        action: "team.created",
        resourceType: "team",
        resourceId: team.id,
        details: { name },
        dataClassification: DataClassification.INTERNAL,
      });
    } catch (err) {
      this.logger.warn(`failed to record team.created audit event for team ${team.id}: ${err instanceof Error ? err.message : err}`);
    }

    return team;
  }
}
