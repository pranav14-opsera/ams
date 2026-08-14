import { Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import type { EnvelopeCiphertext } from "../../tenants/ports/kms-service.port";

export interface BackupCode {
  encrypted: EnvelopeCiphertext;
  used: boolean;
}

export interface UserMfaConfig {
  userId: string;
  tenantId: string;
  totpSecret: EnvelopeCiphertext;
  lastUsedPeriod: number | null;
  backupCodes: BackupCode[];
}

interface Row {
  user_id: string;
  tenant_id: string;
  totp_secret_ciphertext: Buffer;
  totp_secret_iv: Buffer;
  totp_secret_auth_tag: Buffer;
  totp_secret_encrypted_dek: Buffer;
  totp_secret_key_version: number;
  last_used_period: string | null;
  backup_codes: Array<{ encrypted: { ciphertext: string; iv: string; authTag: string; encryptedDataKey: string; keyVersion: number }; used: boolean }>;
}

function bufferField(base64: string): Buffer {
  return Buffer.from(base64, "base64");
}

function toConfig(row: Row): UserMfaConfig {
  return {
    userId: row.user_id,
    tenantId: row.tenant_id,
    totpSecret: {
      ciphertext: row.totp_secret_ciphertext,
      iv: row.totp_secret_iv,
      authTag: row.totp_secret_auth_tag,
      encryptedDataKey: row.totp_secret_encrypted_dek,
      keyVersion: row.totp_secret_key_version,
    },
    lastUsedPeriod: row.last_used_period === null ? null : Number(row.last_used_period),
    backupCodes: row.backup_codes.map((bc) => ({
      used: bc.used,
      encrypted: {
        ciphertext: bufferField(bc.encrypted.ciphertext),
        iv: bufferField(bc.encrypted.iv),
        authTag: bufferField(bc.encrypted.authTag),
        encryptedDataKey: bufferField(bc.encrypted.encryptedDataKey),
        keyVersion: bc.encrypted.keyVersion,
      },
    })),
  };
}

function backupCodesToJsonb(codes: BackupCode[]): string {
  return JSON.stringify(
    codes.map((bc) => ({
      used: bc.used,
      encrypted: {
        ciphertext: bc.encrypted.ciphertext.toString("base64"),
        iv: bc.encrypted.iv.toString("base64"),
        authTag: bc.encrypted.authTag.toString("base64"),
        encryptedDataKey: bc.encrypted.encryptedDataKey.toString("base64"),
        keyVersion: bc.encrypted.keyVersion,
      },
    })),
  );
}

@Injectable()
export class UserMfaConfigRepository {
  async findByUserId(clientOrPool: PoolClient | Pool, userId: string): Promise<UserMfaConfig | null> {
    const result = await clientOrPool.query<Row>("SELECT * FROM user_mfa_configs WHERE user_id = $1", [userId]);
    return result.rows[0] ? toConfig(result.rows[0]) : null;
  }

  async enroll(clientOrPool: PoolClient | Pool, userId: string, tenantId: string, totpSecret: EnvelopeCiphertext, backupCodes: BackupCode[]): Promise<void> {
    await clientOrPool.query(
      `INSERT INTO user_mfa_configs (
         user_id, tenant_id, totp_secret_ciphertext, totp_secret_iv, totp_secret_auth_tag,
         totp_secret_encrypted_dek, totp_secret_key_version, backup_codes
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id) DO UPDATE SET
         totp_secret_ciphertext = EXCLUDED.totp_secret_ciphertext,
         totp_secret_iv = EXCLUDED.totp_secret_iv,
         totp_secret_auth_tag = EXCLUDED.totp_secret_auth_tag,
         totp_secret_encrypted_dek = EXCLUDED.totp_secret_encrypted_dek,
         totp_secret_key_version = EXCLUDED.totp_secret_key_version,
         backup_codes = EXCLUDED.backup_codes,
         last_used_period = NULL,
         updated_at = now()`,
      [userId, tenantId, totpSecret.ciphertext, totpSecret.iv, totpSecret.authTag, totpSecret.encryptedDataKey, totpSecret.keyVersion, backupCodesToJsonb(backupCodes)],
    );
  }

  async recordSuccessfulTotpVerification(clientOrPool: PoolClient | Pool, userId: string, period: number): Promise<void> {
    await clientOrPool.query("UPDATE user_mfa_configs SET last_used_period = $1, updated_at = now() WHERE user_id = $2", [period, userId]);
  }

  async markBackupCodeUsed(clientOrPool: PoolClient | Pool, userId: string, backupCodes: BackupCode[]): Promise<void> {
    await clientOrPool.query("UPDATE user_mfa_configs SET backup_codes = $1, updated_at = now() WHERE user_id = $2", [backupCodesToJsonb(backupCodes), userId]);
  }
}
