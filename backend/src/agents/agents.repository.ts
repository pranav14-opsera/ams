import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../common/database/database.module";
import type { EnvelopeCiphertext } from "../tenants/ports/kms-service.port";
import type { AgentFramework } from "./dto/create-agent.dto";
import type { AgentLifecycleStatus } from "./dto/list-agents-query.dto";

export interface AgentRow {
  id: string;
  tenant_id: string;
  team_id: string | null;
  name: string;
  framework: AgentFramework;
  lifecycle_status: AgentLifecycleStatus;
  connection_config_ciphertext: Buffer;
  connection_config_iv: Buffer;
  connection_config_auth_tag: Buffer;
  connection_config_encrypted_dek: Buffer;
  connection_config_key_version: number;
  metadata: Record<string, unknown>;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AgentListFilters {
  teamId?: string;
  framework?: AgentFramework;
  lifecycleStatus?: AgentLifecycleStatus;
  name?: string;
  limit: number;
  offset: number;
}

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
  ): Promise<AgentRow> {
    const executor = client ?? this.pool;
    const result = await executor.query<AgentRow>(
      `INSERT INTO agents (
         tenant_id, team_id, name, framework, connection_config_ciphertext, connection_config_iv,
         connection_config_auth_tag, connection_config_encrypted_dek, connection_config_key_version, metadata, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
      ],
    );
    return result.rows[0];
  }

  async findAll(client: Pool | PoolClient | undefined, tenantId: string, filters: AgentListFilters): Promise<{ rows: AgentRow[]; total: number }> {
    const executor = client ?? this.pool;
    const conditions = ["tenant_id = $1"];
    const params: unknown[] = [tenantId];

    if (filters.teamId) {
      params.push(filters.teamId);
      conditions.push(`team_id = $${params.length}`);
    }
    if (filters.framework) {
      params.push(filters.framework);
      conditions.push(`framework = $${params.length}`);
    }
    if (filters.lifecycleStatus) {
      params.push(filters.lifecycleStatus);
      conditions.push(`lifecycle_status = $${params.length}`);
    }
    if (filters.name) {
      params.push(`%${filters.name}%`);
      conditions.push(`name ILIKE $${params.length}`);
    }

    const whereClause = conditions.join(" AND ");
    const countResult = await executor.query<{ count: string }>(`SELECT count(*) FROM agents WHERE ${whereClause}`, params);

    const rows = await executor.query<AgentRow>(
      `SELECT * FROM agents WHERE ${whereClause} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filters.limit, filters.offset],
    );

    return { rows: rows.rows, total: Number(countResult.rows[0].count) };
  }

  async findOne(client: Pool | PoolClient | undefined, tenantId: string, id: string): Promise<AgentRow | null> {
    const executor = client ?? this.pool;
    const result = await executor.query<AgentRow>("SELECT * FROM agents WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
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
}
