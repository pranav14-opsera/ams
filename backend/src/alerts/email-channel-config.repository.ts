import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../common/database/database.module";

export interface EmailChannelConfigRow {
  id: string;
  tenant_id: string;
  recipients: string[];
  enabled: boolean;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

@Injectable()
export class EmailChannelConfigRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async create(client: Pool | PoolClient | undefined, tenantId: string, recipients: string[], createdBy: string | null): Promise<EmailChannelConfigRow> {
    const executor = client ?? this.pool;
    const result = await executor.query<EmailChannelConfigRow>(
      "INSERT INTO email_channel_configs (tenant_id, recipients, created_by) VALUES ($1, $2, $3) RETURNING *",
      [tenantId, recipients, createdBy],
    );
    return result.rows[0];
  }

  async findByTenantId(client: Pool | PoolClient | undefined, tenantId: string): Promise<EmailChannelConfigRow[]> {
    const executor = client ?? this.pool;
    const result = await executor.query<EmailChannelConfigRow>("SELECT * FROM email_channel_configs WHERE tenant_id = $1", [tenantId]);
    return result.rows;
  }

  async setEnabled(client: Pool | PoolClient | undefined, tenantId: string, id: string, enabled: boolean): Promise<EmailChannelConfigRow | null> {
    const executor = client ?? this.pool;
    const result = await executor.query<EmailChannelConfigRow>("UPDATE email_channel_configs SET enabled = $1, updated_at = now() WHERE tenant_id = $2 AND id = $3 RETURNING *", [
      enabled,
      tenantId,
      id,
    ]);
    return result.rows[0] ?? null;
  }

  async delete(client: Pool | PoolClient | undefined, tenantId: string, id: string): Promise<boolean> {
    const executor = client ?? this.pool;
    const result = await executor.query("DELETE FROM email_channel_configs WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
    return (result.rowCount ?? 0) > 0;
  }
}
