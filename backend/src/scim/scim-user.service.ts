import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { SessionService } from "../auth/session/session.service";
import { AUDIT_SERVICE, type AuditServicePort } from "../tenants/ports/audit-service.port";
import type { ScimPatchOperation } from "./dto/scim-patch-op.dto";
import { parseScimFilter } from "./scim-filter.parser";
import { scimBadRequest, scimConflict, scimNotFound } from "./scim-error";
import { scimActiveToStatus, scimEmail, toScimUser, type ScimUserCreatePayload, type ScimUserResource, type UserRow } from "./scim-user.mapper";

const DEFAULT_COUNT = 100;
const MAX_COUNT = 1000;
const LOCATION_BASE = "/scim/v2/Users";

export interface ScimListResult {
  schemas: string[];
  totalResults: number;
  itemsPerPage: number;
  startIndex: number;
  Resources: ScimUserResource[];
}

@Injectable()
export class ScimUserService {
  constructor(
    private readonly sessionService: SessionService,
    @Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort,
  ) {}

  async list(client: Pool | PoolClient, tenantId: string, filter: string | undefined, startIndex: number, count: number): Promise<ScimListResult> {
    const safeStartIndex = Math.max(1, startIndex || 1);
    const safeCount = Math.min(MAX_COUNT, count > 0 ? count : DEFAULT_COUNT);

    let whereClause = "tenant_id = $1";
    const params: unknown[] = [tenantId];
    if (filter) {
      const parsed = parseScimFilter(filter, 2);
      whereClause += ` AND ${parsed.whereClause}`;
      params.push(parsed.param);
    }

    const countResult = await client.query<{ count: string }>(`SELECT count(*) FROM users WHERE ${whereClause}`, params);
    const totalResults = Number(countResult.rows[0].count);

    const rows = await client.query<UserRow>(
      `SELECT * FROM users WHERE ${whereClause} ORDER BY created_at ASC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, safeCount, safeStartIndex - 1],
    );

    return {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults,
      itemsPerPage: rows.rows.length,
      startIndex: safeStartIndex,
      Resources: rows.rows.map((row) => toScimUser(row, LOCATION_BASE)),
    };
  }

  async get(client: Pool | PoolClient, tenantId: string, id: string): Promise<ScimUserResource> {
    const row = await this.findRowOrThrow(client, tenantId, id);
    return toScimUser(row, LOCATION_BASE);
  }

  async create(client: Pool | PoolClient, tenantId: string, actorId: string | null, payload: ScimUserCreatePayload): Promise<ScimUserResource> {
    if (!payload.userName) {
      throw scimBadRequest("userName is required.", "invalidValue");
    }
    const email = scimEmail(payload);
    const active = payload.active ?? true;

    const duplicate = await client.query(
      "SELECT id FROM users WHERE tenant_id = $1 AND (email = $2 OR (external_id IS NOT NULL AND external_id = $3))",
      [tenantId, email, payload.externalId ?? null],
    );
    if (duplicate.rows.length > 0) {
      throw scimConflict(`A user with this userName or externalId already exists.`);
    }

    const inserted = await client.query<UserRow>(
      `INSERT INTO users (tenant_id, email, display_name, external_id, status, provisioned_via)
       VALUES ($1, $2, $3, $4, $5, 'scim')
       RETURNING *`,
      [tenantId, email, payload.displayName ?? email, payload.externalId ?? null, scimActiveToStatus(active)],
    );

    await this.auditService.recordEvent({
      tenantId,
      actorId,
      action: "scim.user_created",
      resourceType: "user",
      resourceId: inserted.rows[0].id,
      details: { actor: "scim_client", userName: payload.userName, externalId: payload.externalId ?? null, active },
    });

    return toScimUser(inserted.rows[0], LOCATION_BASE);
  }

  /** RFC 7644 PUT: full replacement of the mutable attributes this platform models. */
  async replace(client: Pool | PoolClient, tenantId: string, actorId: string | null, id: string, payload: ScimUserCreatePayload): Promise<ScimUserResource> {
    const existing = await this.findRowOrThrow(client, tenantId, id);
    const email = scimEmail(payload);
    const wasActive = existing.status === "active";
    const willBeActive = payload.active ?? true;

    const updated = await client.query<UserRow>(
      `UPDATE users SET email = $1, display_name = $2, external_id = $3, status = $4, updated_at = now()
       WHERE tenant_id = $5 AND id = $6 RETURNING *`,
      [email, payload.displayName ?? email, payload.externalId ?? null, scimActiveToStatus(willBeActive), tenantId, id],
    );

    await this.auditService.recordEvent({
      tenantId,
      actorId,
      action: "scim.user_updated",
      resourceType: "user",
      resourceId: id,
      details: { actor: "scim_client", method: "PUT", changes: payload },
    });

    if (wasActive && !willBeActive) {
      await this.deactivateSideEffects(tenantId, id, actorId);
    }

    return toScimUser(updated.rows[0], LOCATION_BASE);
  }

  /** RFC 7644 PATCH: applies each Operation in order. Supports replace on active/displayName/userName/emails. */
  async patch(client: Pool | PoolClient, tenantId: string, actorId: string | null, id: string, operations: ScimPatchOperation[]): Promise<ScimUserResource> {
    const existing = await this.findRowOrThrow(client, tenantId, id);
    const wasActive = existing.status === "active";

    let email = existing.email;
    let displayName = existing.display_name;
    let active = wasActive;

    for (const operation of operations) {
      const path = operation.path?.toLowerCase();
      // Case-insensitive: Entra ID's SCIM client sends "Replace"
      // (capitalized), not RFC 7644's example lowercase "replace" — found
      // via testing against both Okta- and Entra-format fixtures.
      const op = operation.op?.toLowerCase();
      if (op !== "replace" && op !== "add") continue;

      if (path === "active") {
        active = Boolean(operation.value);
      } else if (path === "displayname") {
        displayName = String(operation.value);
      } else if (path === "username" || path === "emails" || path === undefined) {
        // A bare {op:"replace", value:{active:false}} (no path) is common
        // from some IdPs — handle a whole-object replace body too.
        if (typeof operation.value === "object" && operation.value !== null) {
          const obj = operation.value as Record<string, unknown>;
          if ("active" in obj) active = Boolean(obj.active);
          if ("displayName" in obj) displayName = String(obj.displayName);
          if ("userName" in obj) email = String(obj.userName);
        } else if (path === "username" && typeof operation.value === "string") {
          email = operation.value;
        }
      }
    }

    const updated = await client.query<UserRow>(
      `UPDATE users SET email = $1, display_name = $2, status = $3, updated_at = now() WHERE tenant_id = $4 AND id = $5 RETURNING *`,
      [email, displayName, scimActiveToStatus(active), tenantId, id],
    );

    await this.auditService.recordEvent({
      tenantId,
      actorId,
      action: "scim.user_updated",
      resourceType: "user",
      resourceId: id,
      details: { actor: "scim_client", method: "PATCH", operations },
    });

    if (wasActive && !active) {
      await this.deactivateSideEffects(tenantId, id, actorId);
    }

    return toScimUser(updated.rows[0], LOCATION_BASE);
  }

  /** DELETE — a soft deactivation (per this WO's own acceptance criteria), never a hard row delete. */
  async deactivate(client: Pool | PoolClient, tenantId: string, actorId: string | null, id: string): Promise<void> {
    const existing = await this.findRowOrThrow(client, tenantId, id);
    if (existing.status !== "active") return;

    await client.query("UPDATE users SET status = 'deactivated', updated_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
    await this.auditService.recordEvent({
      tenantId,
      actorId,
      action: "scim.user_updated",
      resourceType: "user",
      resourceId: id,
      details: { actor: "scim_client", method: "DELETE" },
    });
    await this.deactivateSideEffects(tenantId, id, actorId);
  }

  private async deactivateSideEffects(tenantId: string, userId: string, actorId: string | null): Promise<void> {
    await this.sessionService.invalidateAllUserSessions(userId, tenantId, "scim_deactivation");
    await this.auditService.recordEvent({
      tenantId,
      actorId,
      action: "scim.user_deactivated",
      resourceType: "user",
      resourceId: userId,
      details: { actor: "scim_client", sessionsInvalidated: true },
    });
  }

  private async findRowOrThrow(client: Pool | PoolClient, tenantId: string, id: string): Promise<UserRow> {
    const result = await client.query<UserRow>("SELECT * FROM users WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
    if (!result.rows[0]) {
      throw scimNotFound(`No user with id ${id}.`);
    }
    return result.rows[0];
  }
}
