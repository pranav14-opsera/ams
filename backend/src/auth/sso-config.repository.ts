import { Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";

export type SsoProtocol = "saml" | "oidc";

export interface EncryptedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  encryptedDataKey: Buffer;
  keyVersion: number;
}

export interface TenantSsoConfig {
  id: string;
  tenantId: string;
  protocol: SsoProtocol;
  samlMetadataUrl: string | null;
  samlEntityId: string | null;
  samlCertPem: string | null;
  oidcDiscoveryUrl: string | null;
  oidcClientId: string | null;
  oidcClientSecret: EncryptedSecret | null;
  metadataRefreshIntervalHours: number;
  metadataLastFetchedAt: Date | null;
  version: number;
}

interface Row {
  id: string;
  tenant_id: string;
  protocol: SsoProtocol;
  saml_metadata_url: string | null;
  saml_entity_id: string | null;
  saml_cert_pem: string | null;
  oidc_discovery_url: string | null;
  oidc_client_id: string | null;
  oidc_client_secret_ciphertext: Buffer | null;
  oidc_client_secret_iv: Buffer | null;
  oidc_client_secret_auth_tag: Buffer | null;
  oidc_client_secret_encrypted_dek: Buffer | null;
  oidc_client_secret_key_version: number | null;
  metadata_refresh_interval_hours: number;
  metadata_last_fetched_at: Date | null;
  version: number;
}

function toConfig(row: Row): TenantSsoConfig {
  const hasEncryptedSecret =
    row.oidc_client_secret_ciphertext && row.oidc_client_secret_iv && row.oidc_client_secret_auth_tag && row.oidc_client_secret_encrypted_dek;

  return {
    id: row.id,
    tenantId: row.tenant_id,
    protocol: row.protocol,
    samlMetadataUrl: row.saml_metadata_url,
    samlEntityId: row.saml_entity_id,
    samlCertPem: row.saml_cert_pem,
    oidcDiscoveryUrl: row.oidc_discovery_url,
    oidcClientId: row.oidc_client_id,
    oidcClientSecret: hasEncryptedSecret
      ? {
          ciphertext: row.oidc_client_secret_ciphertext!,
          iv: row.oidc_client_secret_iv!,
          authTag: row.oidc_client_secret_auth_tag!,
          encryptedDataKey: row.oidc_client_secret_encrypted_dek!,
          keyVersion: row.oidc_client_secret_key_version!,
        }
      : null,
    metadataRefreshIntervalHours: row.metadata_refresh_interval_hours,
    metadataLastFetchedAt: row.metadata_last_fetched_at,
    version: row.version,
  };
}

export interface UpsertSsoConfigInput {
  tenantId: string;
  protocol: SsoProtocol;
  samlMetadataUrl?: string | null;
  samlEntityId?: string | null;
  oidcDiscoveryUrl?: string | null;
  oidcClientId?: string | null;
  oidcClientSecret?: EncryptedSecret | null;
}

@Injectable()
export class SsoConfigRepository {
  async findByTenantId(clientOrPool: PoolClient | Pool, tenantId: string): Promise<TenantSsoConfig | null> {
    const result = await clientOrPool.query<Row>("SELECT * FROM tenant_sso_configs WHERE tenant_id = $1", [tenantId]);
    return result.rows[0] ? toConfig(result.rows[0]) : null;
  }

  /** Insert-or-replace-wholesale — a tenant reconfiguring their IdP replaces the prior config, not merges with it (avoids stale SAML fields lingering under a config since switched to OIDC or vice versa). */
  async upsert(clientOrPool: PoolClient | Pool, input: UpsertSsoConfigInput): Promise<TenantSsoConfig> {
    const secret = input.oidcClientSecret;
    const result = await clientOrPool.query<Row>(
      `INSERT INTO tenant_sso_configs (
         tenant_id, protocol, saml_metadata_url, saml_entity_id,
         oidc_discovery_url, oidc_client_id,
         oidc_client_secret_ciphertext, oidc_client_secret_iv, oidc_client_secret_auth_tag,
         oidc_client_secret_encrypted_dek, oidc_client_secret_key_version
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (tenant_id) DO UPDATE SET
         protocol = EXCLUDED.protocol,
         saml_metadata_url = EXCLUDED.saml_metadata_url,
         saml_entity_id = EXCLUDED.saml_entity_id,
         saml_cert_pem = NULL, -- cleared; refreshed on next metadata fetch, never carried over from a prior protocol/IdP
         oidc_discovery_url = EXCLUDED.oidc_discovery_url,
         oidc_client_id = EXCLUDED.oidc_client_id,
         oidc_client_secret_ciphertext = EXCLUDED.oidc_client_secret_ciphertext,
         oidc_client_secret_iv = EXCLUDED.oidc_client_secret_iv,
         oidc_client_secret_auth_tag = EXCLUDED.oidc_client_secret_auth_tag,
         oidc_client_secret_encrypted_dek = EXCLUDED.oidc_client_secret_encrypted_dek,
         oidc_client_secret_key_version = EXCLUDED.oidc_client_secret_key_version,
         metadata_last_fetched_at = NULL,
         version = tenant_sso_configs.version + 1,
         updated_at = now()
       RETURNING *`,
      [
        input.tenantId,
        input.protocol,
        input.samlMetadataUrl ?? null,
        input.samlEntityId ?? null,
        input.oidcDiscoveryUrl ?? null,
        input.oidcClientId ?? null,
        secret?.ciphertext ?? null,
        secret?.iv ?? null,
        secret?.authTag ?? null,
        secret?.encryptedDataKey ?? null,
        secret?.keyVersion ?? null,
      ],
    );
    return toConfig(result.rows[0]);
  }

  async updateCachedSamlCert(clientOrPool: PoolClient | Pool, tenantId: string, certPem: string): Promise<void> {
    await clientOrPool.query(
      `UPDATE tenant_sso_configs SET saml_cert_pem = $1, metadata_last_fetched_at = now(), updated_at = now() WHERE tenant_id = $2`,
      [certPem, tenantId],
    );
  }

  async markMetadataFetched(clientOrPool: PoolClient | Pool, tenantId: string): Promise<void> {
    await clientOrPool.query(`UPDATE tenant_sso_configs SET metadata_last_fetched_at = now() WHERE tenant_id = $1`, [tenantId]);
  }
}
