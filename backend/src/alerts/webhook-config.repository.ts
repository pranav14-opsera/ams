import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../common/database/database.module";
import type { EnvelopeCiphertext } from "../tenants/ports/kms-service.port";

export interface WebhookConfigRow {
  id: string;
  tenant_id: string;
  url: string;
  enabled: boolean;
  secret_ciphertext: Buffer;
  secret_iv: Buffer;
  secret_auth_tag: Buffer;
  secret_encrypted_dek: Buffer;
  secret_key_version: number;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class WebhookConfigRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async create(client: Pool | PoolClient | undefined, tenantId: string, url: string, secret: EnvelopeCiphertext, createdBy: string | null): Promise<WebhookConfigRow> {
    const executor = client ?? this.pool;
    const result = await executor.query<WebhookConfigRow>(
      `INSERT INTO webhook_configs (tenant_id, url, secret_ciphertext, secret_iv, secret_auth_tag, secret_encrypted_dek, secret_key_version, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [tenantId, url, secret.ciphertext, secret.iv, secret.authTag, secret.encryptedDataKey, secret.keyVersion, createdBy],
    );
    return result.rows[0];
  }

  async findByTenantId(client: Pool | PoolClient | undefined, tenantId: string): Promise<WebhookConfigRow[]> {
    const executor = client ?? this.pool;
    const result = await executor.query<WebhookConfigRow>("SELECT * FROM webhook_configs WHERE tenant_id = $1", [tenantId]);
    return result.rows;
  }

  async findOne(client: Pool | PoolClient | undefined, tenantId: string, id: string): Promise<WebhookConfigRow | null> {
    const executor = client ?? this.pool;
    const result = await executor.query<WebhookConfigRow>("SELECT * FROM webhook_configs WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
    return result.rows[0] ?? null;
  }

  async setEnabled(client: Pool | PoolClient | undefined, tenantId: string, id: string, enabled: boolean): Promise<WebhookConfigRow | null> {
    const executor = client ?? this.pool;
    const result = await executor.query<WebhookConfigRow>("UPDATE webhook_configs SET enabled = $1, updated_at = now() WHERE tenant_id = $2 AND id = $3 RETURNING *", [enabled, tenantId, id]);
    return result.rows[0] ?? null;
  }

  async delete(client: Pool | PoolClient | undefined, tenantId: string, id: string): Promise<boolean> {
    const executor = client ?? this.pool;
    const result = await executor.query("DELETE FROM webhook_configs WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
    return (result.rowCount ?? 0) > 0;
  }
}
