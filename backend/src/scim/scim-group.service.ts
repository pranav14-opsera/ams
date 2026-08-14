import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../common/database/database.module";
import { GroupRoleMappingRepository, type PlatformRole } from "../auth/provisioning/group-role-mapping.repository";
import { AUDIT_SERVICE, type AuditServicePort } from "../tenants/ports/audit-service.port";
import type { ScimPatchOperation } from "./dto/scim-patch-op.dto";
import { scimBadRequest, scimNotFound } from "./scim-error";

const SCIM_GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
const AMS_GROUP_EXTENSION_SCHEMA = "urn:ietf:params:scim:schemas:extension:ams:2.0:Group";
const LOCATION_BASE = "/scim/v2/Groups";

export interface ScimGroupResource {
  schemas: string[];
  id: string;
  displayName: string;
  members: { value: string; display: string }[];
  meta: { resourceType: "Group"; location: string };
  [AMS_GROUP_EXTENSION_SCHEMA]: { platformRole: string; priority: number };
}

export interface ScimGroupCreatePayload {
  displayName: string;
  [AMS_GROUP_EXTENSION_SCHEMA]?: { platformRole?: string; priority?: number };
}

interface GroupRow {
  id: string;
  idp_group: string;
  platform_role: string;
  priority: number;
}

const VALID_ROLES = new Set(["platform_admin", "team_lead", "agent_operator", "finance_manager", "compliance_officer"]);

/**
 * SCIM's core Group schema (RFC 7644) has no notion of "role" — that
 * bridge is this platform's own concept (WO-022's group_role_mappings:
 * idp_group -> platformRole/priority). A SCIM Group IS a
 * group_role_mapping row here, carried as a vendor extension attribute
 * under AMS_GROUP_EXTENSION_SCHEMA, exactly the same bridge WO-022 built
 * for JIT-provisioned SSO logins — SCIM group membership changes now
 * drive that SAME role-resolution logic for provisioned users.
 */
@Injectable()
export class ScimGroupService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly groupRoleMappingRepository: GroupRoleMappingRepository,
    @Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort,
  ) {}

  async list(client: Pool | PoolClient, tenantId: string): Promise<{ schemas: string[]; totalResults: number; Resources: ScimGroupResource[] }> {
    const groups = await client.query<GroupRow>("SELECT id, idp_group, platform_role, priority FROM group_role_mappings WHERE tenant_id = $1 ORDER BY priority ASC", [tenantId]);
    const resources = await Promise.all(groups.rows.map((row) => this.toResource(client, tenantId, row)));
    return { schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"], totalResults: resources.length, Resources: resources };
  }

  async get(client: Pool | PoolClient, tenantId: string, id: string): Promise<ScimGroupResource> {
    const row = await this.findRowOrThrow(client, tenantId, id);
    return this.toResource(client, tenantId, row);
  }

  async create(client: Pool | PoolClient, tenantId: string, actorId: string | null, payload: ScimGroupCreatePayload): Promise<ScimGroupResource> {
    if (!payload.displayName) {
      throw scimBadRequest("displayName is required.", "invalidValue");
    }
    const extension = payload[AMS_GROUP_EXTENSION_SCHEMA];
    const platformRole = extension?.platformRole;
    if (!platformRole || !VALID_ROLES.has(platformRole)) {
      throw scimBadRequest(`A valid ${AMS_GROUP_EXTENSION_SCHEMA} platformRole is required.`, "invalidValue");
    }

    const mapping = await this.groupRoleMappingRepository.upsert(this.pool, tenantId, payload.displayName, platformRole as PlatformRole, extension?.priority ?? 100);

    await this.auditService.recordEvent({
      tenantId,
      actorId,
      action: "scim.group_created",
      resourceType: "group_role_mapping",
      resourceId: mapping.id,
      details: { actor: "scim_client", displayName: payload.displayName, platformRole },
    });

    return this.toResource(client, tenantId, { id: mapping.id, idp_group: mapping.idpGroup, platform_role: mapping.platformRole, priority: mapping.priority });
  }

  async patchMembers(client: Pool | PoolClient, tenantId: string, actorId: string | null, groupId: string, operations: ScimPatchOperation[]): Promise<ScimGroupResource> {
    const row = await this.findRowOrThrow(client, tenantId, groupId);
    const affectedUserIds = new Set<string>();

    for (const operation of operations) {
      if (operation.path?.toLowerCase() !== "members") continue;
      const memberValues = Array.isArray(operation.value) ? operation.value : [];
      const userIds = memberValues.map((m: any) => (typeof m === "string" ? m : m.value)).filter(Boolean);

      const op = operation.op?.toLowerCase(); // case-insensitive — see scim-user.service.ts's patch() for why
      if (op === "add") {
        for (const userId of userIds) {
          await client.query(
            "INSERT INTO scim_group_memberships (scim_group_id, user_id, tenant_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
            [groupId, userId, tenantId],
          );
          affectedUserIds.add(userId);
        }
      } else if (op === "remove") {
        for (const userId of userIds) {
          await client.query("DELETE FROM scim_group_memberships WHERE scim_group_id = $1 AND user_id = $2 AND tenant_id = $3", [groupId, userId, tenantId]);
          affectedUserIds.add(userId);
        }
      }
    }

    for (const userId of affectedUserIds) {
      await this.reassignRole(client, tenantId, userId, actorId);
    }

    await this.auditService.recordEvent({
      tenantId,
      actorId,
      action: "scim.group_membership_changed",
      resourceType: "group_role_mapping",
      resourceId: groupId,
      details: { actor: "scim_client", operations, affectedUsers: [...affectedUserIds] },
    });

    return this.toResource(client, tenantId, row);
  }

  /** Re-resolves and persists a user's platform role from ALL their current SCIM group memberships — same "lowest-priority-value wins, no match is deny-by-default NULL" resolution WO-022's JIT provisioning uses. */
  private async reassignRole(client: Pool | PoolClient, tenantId: string, userId: string, actorId: string | null): Promise<void> {
    const memberships = await client.query<{ idp_group: string }>(
      `SELECT grm.idp_group FROM scim_group_memberships sgm
       JOIN group_role_mappings grm ON grm.id = sgm.scim_group_id
       WHERE sgm.user_id = $1 AND sgm.tenant_id = $2`,
      [userId, tenantId],
    );
    const groupNames = memberships.rows.map((r) => r.idp_group);
    const resolvedRole = await this.groupRoleMappingRepository.resolveRole(this.pool, tenantId, groupNames);

    const userRow = await client.query<{ role: string | null }>("SELECT role FROM users WHERE tenant_id = $1 AND id = $2", [tenantId, userId]);
    if (!userRow.rows[0] || userRow.rows[0].role === resolvedRole) return;

    await client.query("UPDATE users SET role = $1, updated_at = now() WHERE tenant_id = $2 AND id = $3", [resolvedRole, tenantId, userId]);
    await this.auditService.recordEvent({
      tenantId,
      actorId,
      action: "scim.user_role_reassigned",
      resourceType: "user",
      resourceId: userId,
      details: { actor: "scim_client", previousRole: userRow.rows[0].role, newRole: resolvedRole, groups: groupNames },
    });
  }

  private async toResource(client: Pool | PoolClient, tenantId: string, row: GroupRow): Promise<ScimGroupResource> {
    const members = await client.query<{ user_id: string; display_name: string }>(
      `SELECT sgm.user_id, u.display_name FROM scim_group_memberships sgm
       JOIN users u ON u.id = sgm.user_id
       WHERE sgm.scim_group_id = $1 AND sgm.tenant_id = $2`,
      [row.id, tenantId],
    );

    return {
      schemas: [SCIM_GROUP_SCHEMA, AMS_GROUP_EXTENSION_SCHEMA],
      id: row.id,
      displayName: row.idp_group,
      members: members.rows.map((m) => ({ value: m.user_id, display: m.display_name })),
      meta: { resourceType: "Group", location: `${LOCATION_BASE}/${row.id}` },
      [AMS_GROUP_EXTENSION_SCHEMA]: { platformRole: row.platform_role, priority: row.priority },
    };
  }

  private async findRowOrThrow(client: Pool | PoolClient, tenantId: string, id: string): Promise<GroupRow> {
    const result = await client.query<GroupRow>("SELECT id, idp_group, platform_role, priority FROM group_role_mappings WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
    if (!result.rows[0]) {
      throw scimNotFound(`No group with id ${id}.`);
    }
    return result.rows[0];
  }
}
