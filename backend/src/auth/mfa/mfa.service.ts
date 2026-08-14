import { HttpException, HttpStatus, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { PG_POOL } from "../../common/database/database.module";
import { DataClassification } from "../../classification/data-classification.enum";
import { EncryptionService } from "../../encryption/encryption.service";
import { AUDIT_SERVICE, type AuditServicePort } from "../../tenants/ports/audit-service.port";
import { SESSION_STORE, type SessionStorePort } from "../session/session-store.port";
import { MFA_RATE_LIMITER, type MfaRateLimiterPort } from "./mfa-rate-limiter.port";
import { TotpProviderService } from "./totp-provider.service";
import { UserMfaConfigRepository, type BackupCode } from "./user-mfa-config.repository";

const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // excludes visually-ambiguous chars (0/O, 1/I/L)
const BACKUP_CODE_LENGTH = 10;

export interface EnrollmentResult {
  provisioningUri: string;
  backupCodes: string[]; // plaintext — shown to the user exactly once, never retrievable again
}

@Injectable()
export class MfaService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly totpProvider: TotpProviderService,
    private readonly userMfaConfigRepository: UserMfaConfigRepository,
    private readonly encryptionService: EncryptionService,
    @Inject(SESSION_STORE) private readonly sessionStore: SessionStorePort,
    @Inject(MFA_RATE_LIMITER) private readonly rateLimiter: MfaRateLimiterPort,
    @Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort,
  ) {}

  async enroll(userId: string, tenantId: string, userEmail: string): Promise<EnrollmentResult> {
    const { base32Secret, provisioningUri } = this.totpProvider.generateSecret("AMS Platform", userEmail);
    const encryptedSecret = await this.encryptionService.encrypt(tenantId, Buffer.from(base32Secret, "utf8"));

    const plaintextCodes: string[] = [];
    const backupCodes: BackupCode[] = [];
    for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
      const code = this.generateBackupCode();
      plaintextCodes.push(code);
      const encrypted = await this.encryptionService.encrypt(tenantId, Buffer.from(code, "utf8"));
      backupCodes.push({ encrypted, used: false });
    }

    await this.userMfaConfigRepository.enroll(this.pool, userId, tenantId, encryptedSecret, backupCodes);

    await this.auditService.recordEvent({
      tenantId,
      actorId: userId,
      action: "auth.mfa.enrolled",
      resourceType: "user_mfa_config",
      resourceId: userId,
      details: {},
      dataClassification: DataClassification.RESTRICTED,
    });

    return { provisioningUri, backupCodes: plaintextCodes };
  }

  async verify(userId: string, tenantId: string, sessionId: string, code: string): Promise<void> {
    const { limited } = await this.rateLimiter.checkAndRecordAttempt(userId);
    if (limited) {
      await this.auditService.recordEvent({
        tenantId,
        actorId: userId,
        action: "auth.mfa.rate_limited",
        resourceType: "user_mfa_config",
        resourceId: userId,
        details: {},
        dataClassification: DataClassification.RESTRICTED,
      });
      throw new HttpException("Too many MFA verification attempts. Try again later.", HttpStatus.TOO_MANY_REQUESTS);
    }

    const config = await this.userMfaConfigRepository.findByUserId(this.pool, userId);
    if (!config) {
      throw new UnauthorizedException("MFA is not enrolled for this account.");
    }

    const secretBuffer = await this.encryptionService.decrypt(tenantId, config.totpSecret);
    const matchedPeriod = this.totpProvider.validate(secretBuffer.toString("utf8"), code);

    if (matchedPeriod !== null) {
      if (config.lastUsedPeriod !== null && matchedPeriod <= config.lastUsedPeriod) {
        // Replay: the exact same (or an older) valid code submitted
        // again. A code's own validity window is what would otherwise
        // let it be reused for up to ~90 seconds (±1 period tolerance).
        await this.recordFailure(tenantId, userId, "replayed_code");
        throw new UnauthorizedException("This MFA code has already been used.");
      }
      await this.userMfaConfigRepository.recordSuccessfulTotpVerification(this.pool, userId, matchedPeriod);
      await this.elevateAndRecordSuccess(tenantId, userId, sessionId, "totp");
      return;
    }

    const matchedBackupCode = await this.findMatchingBackupCode(tenantId, config.backupCodes, code);
    if (matchedBackupCode) {
      matchedBackupCode.used = true;
      await this.userMfaConfigRepository.markBackupCodeUsed(this.pool, userId, config.backupCodes);
      await this.elevateAndRecordSuccess(tenantId, userId, sessionId, "backup_code");
      return;
    }

    await this.recordFailure(tenantId, userId, "invalid_code");
    throw new UnauthorizedException("Invalid MFA code.");
  }

  /** Checks every UNUSED backup code (decrypting each — at most 10, negligible cost) with a constant-time comparison, so which code (if any) matched isn't observable via timing. */
  private async findMatchingBackupCode(tenantId: string, backupCodes: BackupCode[], submittedCode: string): Promise<BackupCode | null> {
    const submittedBuffer = Buffer.from(submittedCode, "utf8");
    for (const backupCode of backupCodes) {
      if (backupCode.used) continue;
      const decrypted = await this.encryptionService.decrypt(tenantId, backupCode.encrypted);
      if (decrypted.length === submittedBuffer.length && timingSafeEqual(decrypted, submittedBuffer)) {
        return backupCode;
      }
    }
    return null;
  }

  private async recordFailure(tenantId: string, userId: string, reason: string): Promise<void> {
    await this.auditService.recordEvent({
      tenantId,
      actorId: userId,
      action: "auth.mfa.verification_failed",
      resourceType: "user_mfa_config",
      resourceId: userId,
      details: { reason },
      dataClassification: DataClassification.RESTRICTED,
    });
  }

  private async elevateAndRecordSuccess(tenantId: string, userId: string, sessionId: string, method: "totp" | "backup_code"): Promise<void> {
    await this.sessionStore.update(sessionId, { mfaElevated: true, mfaElevatedAt: new Date() });
    await this.rateLimiter.reset(userId);
    await this.auditService.recordEvent({
      tenantId,
      actorId: userId,
      action: "auth.mfa.verified",
      resourceType: "user_mfa_config",
      resourceId: userId,
      details: { method },
      dataClassification: DataClassification.RESTRICTED,
    });
  }

  private generateBackupCode(): string {
    const bytes = randomBytes(BACKUP_CODE_LENGTH);
    let code = "";
    for (let i = 0; i < BACKUP_CODE_LENGTH; i++) {
      code += BACKUP_CODE_ALPHABET[bytes[i] % BACKUP_CODE_ALPHABET.length];
    }
    return code;
  }
}
