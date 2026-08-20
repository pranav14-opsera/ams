import { randomBytes } from "node:crypto";
import { ConflictException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../common/database/database.module";
import { AdapterHealthService, type CompatibilityWarning } from "../adapters/health/adapter-health.service";
import { DataClassification } from "../classification/data-classification.enum";
import { EncryptionService } from "../encryption/encryption.service";
import { AUDIT_SERVICE, type AuditServicePort } from "../tenants/ports/audit-service.port";
import { AgentResource, toAgentResource } from "./agent.mapper";
import { AgentsRepository } from "./agents.repository";
import type { AgentFramework } from "./dto/create-agent.dto";
import type { AgentLifecycleStatus, AgentSortField, SortOrder } from "./dto/list-agents-query.dto";

export interface AgentListResult {
  agents: AgentResource[];
  total: number;
  limit: number;
  offset: number;
}

export interface CreateAgentResult extends AgentResource {
  /**
   * The raw HMAC shared secret (WO-034) for signing X-Signature-256 on
   * telemetry submissions — revealed exactly once, here, at creation
   * time. Never persisted in plaintext (only its BYOK-encrypted form is
   * stored) and never returned by any other endpoint (findOne/findAll/
   * update), same write-only convention as connection_config.
   */
  hmacSecret: string;
  /**
   * WO-039's advisory (never blocking) framework-version compatibility
   * check — only present when the caller supplied `frameworkVersion` in
   * the create request.
   */
  compatibilityWarning?: CompatibilityWarning;
}

@Injectable()
export class AgentsService {
  private readonly logger = new Logger(AgentsService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly repository: AgentsRepository,
    private readonly encryptionService: EncryptionService,
    @Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort,
    private readonly adapterHealthService: AdapterHealthService,
  ) {}

  async create(
    client: Pool | PoolClient | undefined,
    tenantId: string,
    actorId: string | null,
    input: { name: string; framework: AgentFramework; teamId?: string; connectionConfig: Record<string, unknown>; metadata?: Record<string, unknown>; frameworkVersion?: string },
  ): Promise<CreateAgentResult> {
    const existing = await this.pool.query("SELECT id FROM agents WHERE tenant_id = $1 AND name = $2", [tenantId, input.name]);
    if (existing.rows.length > 0) {
      throw new ConflictException(`An agent named "${input.name}" already exists for this tenant.`);
    }

    const encryptedConfig = await this.encryptionService.encrypt(tenantId, Buffer.from(JSON.stringify(input.connectionConfig), "utf8"));
    // 256-bit random shared secret (WO-034) for HMAC-SHA256 telemetry
    // signing — generated once at registration, same BYOK envelope
    // encryption as connection_config, never stored in plaintext.
    const hmacSecretBytes = randomBytes(32);
    const encryptedHmacSecret = await this.encryptionService.encrypt(tenantId, hmacSecretBytes);
    const row = await this.repository.create(
      client,
      tenantId,
      input.name,
      input.framework,
      input.teamId ?? null,
      encryptedConfig,
      input.metadata ?? {},
      actorId,
      encryptedHmacSecret,
    );

    await this.auditService.recordEvent({
      tenantId,
      actorId,
      action: "agent.created",
      resourceType: "agent",
      resourceId: row.id,
      details: { name: input.name, framework: input.framework, teamId: input.teamId ?? null },
      dataClassification: DataClassification.RESTRICTED,
    });

    const compatibilityWarning = input.frameworkVersion
      ? await this.adapterHealthService.checkVersionCompatibility(input.framework, input.frameworkVersion)
      : undefined;

    return { ...toAgentResource(row), hmacSecret: hmacSecretBytes.toString("hex"), compatibilityWarning };
  }

  async findAll(
    client: Pool | PoolClient | undefined,
    tenantId: string,
    filters: {
      teamId?: string;
      framework?: AgentFramework | AgentFramework[];
      lifecycleStatus?: AgentLifecycleStatus | AgentLifecycleStatus[];
      name?: string;
      limit?: number;
      offset?: number;
      sortBy?: AgentSortField;
      sortOrder?: SortOrder;
    },
    actorId: string | null = null,
  ): Promise<AgentListResult> {
    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;
    const { rows, total } = await this.repository.findAll(client, tenantId, { ...filters, limit, offset });

    // AC (WO-079): "every page load and filter/sort action produces a
    // structured audit log entry" — same never-fail-the-read posture as
    // TeamUsageDashboardService.recordDashboardViewAuditEvent
    // (dashboard.team_usage_viewed) and DashboardService's own
    // recordAccessAuditEvent (dashboard.health_view_accessed); awaited
    // (rather than those two's fire-and-forget) so the entry genuinely
    // exists by the time this call resolves — findAll is called far more
    // frequently, in tighter request/cleanup cycles, than a dashboard page
    // load, and a dangling unawaited insert racing a caller's own cleanup
    // is exactly the kind of flake an audit trail for a compliance-relevant
    // read path shouldn't have.
    try {
      await this.auditService.recordEvent({
        tenantId,
        actorId,
        action: "agent_registry.viewed",
        resourceType: "agent_registry",
        resourceId: tenantId,
        details: { filters: { teamId: filters.teamId, framework: filters.framework, lifecycleStatus: filters.lifecycleStatus, name: filters.name }, sortBy: filters.sortBy, sortOrder: filters.sortOrder, limit, offset },
        dataClassification: DataClassification.INTERNAL,
      });
    } catch (err) {
      this.logger.warn(`failed to record agent registry view audit event: ${err instanceof Error ? err.message : err}`);
    }

    return { agents: rows.map(toAgentResource), total, limit, offset };
  }

  async findOne(client: Pool | PoolClient | undefined, tenantId: string, id: string): Promise<AgentResource> {
    const row = await this.repository.findOne(client, tenantId, id);
    if (!row) throw new NotFoundException(`No agent with id ${id}.`);
    return toAgentResource(row);
  }

  async update(
    client: Pool | PoolClient | undefined,
    tenantId: string,
    actorId: string | null,
    id: string,
    input: { name?: string; teamId?: string; connectionConfig?: Record<string, unknown>; metadata?: Record<string, unknown> },
  ): Promise<AgentResource> {
    const existing = await this.repository.findOne(client, tenantId, id);
    if (!existing) throw new NotFoundException(`No agent with id ${id}.`);

    if (input.name && input.name !== existing.name) {
      const duplicate = await this.pool.query("SELECT id FROM agents WHERE tenant_id = $1 AND name = $2 AND id != $3", [tenantId, input.name, id]);
      if (duplicate.rows.length > 0) {
        throw new ConflictException(`An agent named "${input.name}" already exists for this tenant.`);
      }
    }

    const encryptedConfig = input.connectionConfig
      ? await this.encryptionService.encrypt(tenantId, Buffer.from(JSON.stringify(input.connectionConfig), "utf8"))
      : undefined;

    const row = await this.repository.update(client, tenantId, id, {
      name: input.name,
      teamId: input.teamId,
      connectionConfig: encryptedConfig,
      metadata: input.metadata,
    });
    if (!row) throw new NotFoundException(`No agent with id ${id}.`);

    await this.auditService.recordEvent({
      tenantId,
      actorId,
      action: "agent.updated",
      resourceType: "agent",
      resourceId: id,
      details: {
        nameChanged: input.name !== undefined,
        teamChanged: input.teamId !== undefined,
        credentialsRotated: input.connectionConfig !== undefined,
        metadataChanged: input.metadata !== undefined,
      },
      dataClassification: DataClassification.RESTRICTED,
    });

    return toAgentResource(row);
  }

  async remove(client: Pool | PoolClient | undefined, tenantId: string, actorId: string | null, id: string): Promise<AgentResource> {
    const row = await this.repository.softDelete(client, tenantId, id);
    if (!row) throw new NotFoundException(`No agent with id ${id}.`);

    await this.auditService.recordEvent({
      tenantId,
      actorId,
      action: "agent.decommissioned",
      resourceType: "agent",
      resourceId: id,
      details: {},
      dataClassification: DataClassification.RESTRICTED,
    });

    return toAgentResource(row);
  }
}
