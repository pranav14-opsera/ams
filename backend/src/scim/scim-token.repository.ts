import { Injectable } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";

export interface ScimTokenRecord {
  id: string;
  tenantId: string;
  description: string | null;
  createdAt: Date;
  revokedAt: Date | null;
}

function toDomain(row: any): ScimTokenRecord {
  return { id: row.id, tenantId: row.tenant_id, description: row.description, createdAt: row.created_at, revokedAt: row.revoked_at };
}

export function hashScimToken(rawToken: string): Buffer {
  return createHash("sha256").update(rawToken).digest();
}

@Injectable()
export class ScimTokenRepository {
  /** Returns the RAW token exactly once — only its hash is ever persisted or retrievable again. */
  async generate(pool: Pool, tenantId: string, description: string | null, createdBy: string | null): Promise<{ rawToken: string; record: ScimTokenRecord }> {
    const rawToken = `scim_${randomBytes(32).toString("hex")}`;
    const tokenHash = hashScimToken(rawToken);
    const result = await pool.query(
      "INSERT INTO scim_tokens (tenant_id, token_hash, description, created_by) VALUES ($1, $2, $3, $4) RETURNING *",
      [tenantId, tokenHash, description, createdBy],
    );
    return { rawToken, record: toDomain(result.rows[0]) };
  }

  async findByRawToken(pool: Pool, rawToken: string): Promise<ScimTokenRecord | null> {
    const result = await pool.query("SELECT * FROM scim_tokens WHERE token_hash = $1 AND revoked_at IS NULL", [hashScimToken(rawToken)]);
    return result.rows[0] ? toDomain(result.rows[0]) : null;
  }

  async list(pool: Pool, tenantId: string): Promise<ScimTokenRecord[]> {
    const result = await pool.query("SELECT * FROM scim_tokens WHERE tenant_id = $1 ORDER BY created_at DESC", [tenantId]);
    return result.rows.map(toDomain);
  }

  async revoke(pool: Pool, tenantId: string, id: string): Promise<boolean> {
    const result = await pool.query("UPDATE scim_tokens SET revoked_at = now() WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL", [tenantId, id]);
    return (result.rowCount ?? 0) > 0;
  }
}
