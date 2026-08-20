import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../common/database/database.module";
import type { EnvelopeCiphertext } from "../tenants/ports/kms-service.port";
import type { AgentFramework } from "./dto/create-agent.dto";
import type { AgentLifecycleStatus, AgentSortField, SortOrder } from "./dto/list-agents-query.dto";

export interface AgentRow {
  id: string;
  tenant_id: string;
  team_id: string | null;
  // Populated by a LEFT JOIN against `teams` in findAll only — every other
  // repository method here returns a bare agents row and leaves this
  // undefined (not present on the underlying table itself).
  team_name?: string | null;
  name: string;
  framework: AgentFramework;
  lifecycle_status: AgentLifecycleStatus;
  connection_config_ciphertext: Buffer;
  connection_config_iv: Buffer;
  connection_config_auth_tag: Buffer;
  connection_config_encrypted_dek: Buffer;
  connection_config_key_version: number;
  hmac_secret_ciphertext: Buffer;
  hmac_secret_iv: Buffer;
  hmac_secret_auth_tag: Buffer;
  hmac_secret_encrypted_dek: Buffer;
  hmac_secret_key_version: number;
  metadata: Record<string, unknown>;
  version: number;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AgentListFilters {
  teamId?: string;
  // Single-value form kept alongside the array form: BulkLifecycleService's
  // own filter resolution (resolveAgentIds) still passes a bare single
  // value here, unrelated to WO-079's own multi-select AC — both call
  // shapes are normalized to an array internally (see toFilterArray below).
  framework?: AgentFramework | AgentFramework[];
  lifecycleStatus?: AgentLifecycleStatus | AgentLifecycleStatus[];
  name?: string;
  limit: number;
  offset: number;
  sortBy?: AgentSortField;
  sortOrder?: SortOrder;
}

function toFilterArray<T>(value: T | T[] | undefined): T[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

// WO-079: whitelisted column mapping — sortBy is validated by
// ListAgentsQueryDto's own @IsIn(AGENT_SORT_FIELDS), but this map is the
// actual defense against SQL injection (a raw column string is never
// interpolated; only a value looked up from this fixed table is).
const SORT_COLUMNS: Record<AgentSortField, string> = {
  name: "agents.name",
  framework: "agents.framework",
  lifecycleStatus: "agents.lifecycle_status",
  // No dedicated heartbeat/last-seen column exists yet (see agent.mapper.ts) — `updated_at` is the closest real proxy, and it's what AgentResource.lastSeen is itself derived from, so sorting by it is consistent with what the client displays.
  lastSeen: "agents.updated_at",
};

@Injectable()
export class AgentsRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async create(
    client: Pool | PoolClient | undefined,
    tenantId: string,
    name: string,
    framework: AgentFramework,
    teamId: string | null,
    connectionConfig: EnvelopeCiphertext,
    metadata: Record<string, unknown>,
    createdBy: string | null,
    hmacSecret: EnvelopeCiphertext,
  ): Promise<AgentRow> {
    const executor = client ?? this.pool;
    const result = await executor.query<AgentRow>(
      `INSERT INTO agents (
         tenant_id, team_id, name, framework, connection_config_ciphertext, connection_config_iv,
         connection_config_auth_tag, connection_config_encrypted_dek, connection_config_key_version, metadata, created_by,
         hmac_secret_ciphertext, hmac_secret_iv, hmac_secret_auth_tag, hmac_secret_encrypted_dek, hmac_secret_key_version
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       RETURNING *`,
      [
        tenantId,
        teamId,
        name,
        framework,
        connectionConfig.ciphertext,
        connectionConfig.iv,
        connectionConfig.authTag,
        connectionConfig.encryptedDataKey,
        connectionConfig.keyVersion,
        metadata,
        createdBy,
        hmacSecret.ciphertext,
        hmacSecret.iv,
        hmacSecret.authTag,
        hmacSecret.encryptedDataKey,
        hmacSecret.keyVersion,
      ],
    );
    return result.rows[0];
  }

  async findAll(client: Pool | PoolClient | undefined, tenantId: string, filters: AgentListFilters): Promise<{ rows: AgentRow[]; total: number }> {
    const executor = client ?? this.pool;
    const conditions = ["agents.tenant_id = $1"];
    const params: unknown[] = [tenantId];

    if (filters.teamId) {
      params.push(filters.teamId);
      conditions.push(`agents.team_id = $${params.length}`);
    }
    const frameworks = toFilterArray(filters.framework);
    if (frameworks && frameworks.length > 0) {
      params.push(frameworks);
      conditions.push(`agents.framework = ANY($${params.length}::text[])`);
    }
    const lifecycleStatuses = toFilterArray(filters.lifecycleStatus);
    if (lifecycleStatuses && lifecycleStatuses.length > 0) {
      params.push(lifecycleStatuses);
      conditions.push(`agents.lifecycle_status = ANY($${params.length}::text[])`);
    }
    if (filters.name) {
      params.push(`%${filters.name}%`);
      conditions.push(`agents.name ILIKE $${params.length}`);
    }

    const whereClause = conditions.join(" AND ");
    const countResult = await executor.query<{ count: string }>(`SELECT count(*) FROM agents WHERE ${whereClause}`, params);

    // AC (WO-079): server-side sort by Name/Framework/Status/Last Seen with
    // a stable secondary key so equally-ranked rows don't reorder between
    // pages as the underlying data changes between requests.
    const sortColumn = filters.sortBy ? SORT_COLUMNS[filters.sortBy] : "agents.created_at";
    const sortDirection = filters.sortOrder === "asc" ? "ASC" : "DESC";
    const orderClause = filters.sortBy ? `${sortColumn} ${sortDirection}, agents.id ASC` : `${sortColumn} DESC, agents.id ASC`;

    const rows = await executor.query<AgentRow>(
      `SELECT agents.*, teams.name AS team_name
       FROM agents
       LEFT JOIN teams ON teams.id = agents.team_id
       WHERE ${whereClause}
       ORDER BY ${orderClause}
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filters.limit, filters.offset],
    );

    return { rows: rows.rows, total: Number(countResult.rows[0].count) };
  }

  async findOne(client: Pool | PoolClient | undefined, tenantId: string, id: string): Promise<AgentRow | null> {
    const executor = client ?? this.pool;
    const result = await executor.query<AgentRow>("SELECT * FROM agents WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
    return result.rows[0] ?? null;
  }

  // semgrep: raw-sql-missing-tenant-filter allowlisted (.semgrep.yml) —
  // deliberately tenant-less. HmacValidationMiddleware runs BEFORE tenant
  // context exists for a telemetry request (the caller authenticates via
  // a per-agent HMAC secret, not a tenant-scoped JWT); this is the one
  // legitimate lookup that has to resolve an agent (and therefore its
  // tenant) by id alone, same "necessarily tenant-less" class as
  // scim-auth.guard.ts's token lookup.
  async findByIdAcrossTenants(client: Pool | PoolClient | undefined, id: string): Promise<AgentRow | null> {
    const executor = client ?? this.pool;
    const result = await executor.query<AgentRow>("SELECT * FROM agents WHERE id = $1", [id]);
    return result.rows[0] ?? null;
  }

  async update(
    client: Pool | PoolClient | undefined,
    tenantId: string,
    id: string,
    fields: {
      name?: string;
      teamId?: string | null;
      connectionConfig?: EnvelopeCiphertext;
      metadata?: Record<string, unknown>;
    },
  ): Promise<AgentRow | null> {
    const executor = client ?? this.pool;
    const setClauses: string[] = [];
    const params: unknown[] = [tenantId, id];

    if (fields.name !== undefined) {
      params.push(fields.name);
      setClauses.push(`name = $${params.length}`);
    }
    if (fields.teamId !== undefined) {
      params.push(fields.teamId);
      setClauses.push(`team_id = $${params.length}`);
    }
    if (fields.connectionConfig !== undefined) {
      params.push(fields.connectionConfig.ciphertext);
      setClauses.push(`connection_config_ciphertext = $${params.length}`);
      params.push(fields.connectionConfig.iv);
      setClauses.push(`connection_config_iv = $${params.length}`);
      params.push(fields.connectionConfig.authTag);
      setClauses.push(`connection_config_auth_tag = $${params.length}`);
      params.push(fields.connectionConfig.encryptedDataKey);
      setClauses.push(`connection_config_encrypted_dek = $${params.length}`);
      params.push(fields.connectionConfig.keyVersion);
      setClauses.push(`connection_config_key_version = $${params.length}`);
    }
    if (fields.metadata !== undefined) {
      params.push(fields.metadata);
      setClauses.push(`metadata = $${params.length}`);
    }

    if (setClauses.length === 0) {
      return this.findOne(executor, tenantId, id);
    }

    setClauses.push("updated_at = now()");
    const result = await executor.query<AgentRow>(
      `UPDATE agents SET ${setClauses.join(", ")} WHERE tenant_id = $1 AND id = $2 RETURNING *`,
      params,
    );
    return result.rows[0] ?? null;
  }

  async softDelete(client: Pool | PoolClient | undefined, tenantId: string, id: string): Promise<AgentRow | null> {
    const executor = client ?? this.pool;
    const result = await executor.query<AgentRow>(
      "UPDATE agents SET lifecycle_status = 'decommissioned', updated_at = now() WHERE tenant_id = $1 AND id = $2 RETURNING *",
      [tenantId, id],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Compare-and-swap on both `version` and the expected current
   * `lifecycle_status` in the same WHERE clause: a concurrent transition
   * that ran between LifecycleService's read and this write will have
   * bumped `version`, so this UPDATE affects zero rows and the caller
   * (LifecycleService) treats that as an optimistic-lock conflict rather
   * than silently overwriting a state change it never saw.
   */
  async compareAndSwapLifecycleStatus(
    client: Pool | PoolClient | undefined,
    tenantId: string,
    id: string,
    expectedStatus: AgentLifecycleStatus,
    expectedVersion: number,
    newStatus: AgentLifecycleStatus,
  ): Promise<AgentRow | null> {
    const executor = client ?? this.pool;
    const result = await executor.query<AgentRow>(
      `UPDATE agents SET lifecycle_status = $1, version = version + 1, updated_at = now()
       WHERE tenant_id = $2 AND id = $3 AND lifecycle_status = $4 AND version = $5
       RETURNING *`,
      [newStatus, tenantId, id, expectedStatus, expectedVersion],
    );
    return result.rows[0] ?? null;
  }
}
