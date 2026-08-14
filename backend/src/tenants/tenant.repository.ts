import { Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  dataResidencyRegion: "us" | "eu";
  status: "active" | "suspended" | "offboarding" | "offboarded";
  isActive: boolean;
  encryptionKeyArn: string | null;
  settings: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  data_residency_region: "us" | "eu";
  status: Tenant["status"];
  is_active: boolean;
  encryption_key_arn: string | null;
  settings: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

function toTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    dataResidencyRegion: row.data_residency_region,
    status: row.status,
    isActive: row.is_active,
    encryptionKeyArn: row.encryption_key_arn,
    settings: row.settings,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// All queries are parameterized ($1, $2, ...) — never string-interpolated
// — per the acceptance criteria and this codebase's established
// convention (see database/tests/test_rls_isolation.sh).
@Injectable()
export class TenantRepository {
  async create(
    client: PoolClient,
    input: { name: string; slug: string; dataResidencyRegion: "us" | "eu"; settings: Record<string, unknown> },
  ): Promise<Tenant> {
    const result = await client.query<TenantRow>(
      `INSERT INTO tenants (name, slug, data_residency_region, settings)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.name, input.slug, input.dataResidencyRegion, JSON.stringify(input.settings)],
    );
    return toTenant(result.rows[0]);
  }

  async findById(clientOrPool: PoolClient | Pool, id: string): Promise<Tenant | null> {
    const result = await clientOrPool.query<TenantRow>("SELECT * FROM tenants WHERE id = $1", [id]);
    return result.rows[0] ? toTenant(result.rows[0]) : null;
  }

  async findBySlug(clientOrPool: PoolClient | Pool, slug: string): Promise<Tenant | null> {
    const result = await clientOrPool.query<TenantRow>("SELECT * FROM tenants WHERE slug = $1", [slug]);
    return result.rows[0] ? toTenant(result.rows[0]) : null;
  }

  async updateEncryptionKeyArn(client: PoolClient, id: string, encryptionKeyArn: string): Promise<void> {
    await client.query("UPDATE tenants SET encryption_key_arn = $1, updated_at = now() WHERE id = $2", [encryptionKeyArn, id]);
  }

  async updateSettings(clientOrPool: PoolClient | Pool, id: string, settings: Record<string, unknown>): Promise<Tenant | null> {
    const result = await clientOrPool.query<TenantRow>(
      "UPDATE tenants SET settings = $1, updated_at = now() WHERE id = $2 RETURNING *",
      [JSON.stringify(settings), id],
    );
    return result.rows[0] ? toTenant(result.rows[0]) : null;
  }
}
