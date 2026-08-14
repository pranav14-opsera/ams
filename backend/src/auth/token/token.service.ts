import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { AUDIT_SERVICE, type AuditServicePort } from "../../tenants/ports/audit-service.port";
import { RBAC_SERVICE, type RbacServicePort } from "../../tenants/ports/rbac-service.port";
import { JwtKeyService } from "../jwt/jwt-key.service";
import { REFRESH_TOKEN_STORE, type RefreshTokenStorePort } from "./refresh-token-store.port";

const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes, per this WO's acceptance criteria
const REFRESH_TOKEN_TTL_SECONDS = 8 * 60 * 60; // 8 hours

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class TokenService {
  constructor(
    private readonly keyService: JwtKeyService,
    @Inject(REFRESH_TOKEN_STORE) private readonly refreshTokenStore: RefreshTokenStorePort,
    @Inject(RBAC_SERVICE) private readonly rbacService: RbacServicePort,
    @Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort,
  ) {}

  async issueTokenPair(userId: string, tenantId: string, roles: string[], deviceFingerprint: string, mfaVerified = false): Promise<TokenPair> {
    const accessToken = await this.mintAccessToken(userId, tenantId, roles, mfaVerified);
    const refreshToken = randomBytes(32).toString("hex");
    await this.refreshTokenStore.store(refreshToken, { userId, tenantId, deviceFingerprint, roles }, REFRESH_TOKEN_TTL_SECONDS);
    return { accessToken, refreshToken };
  }

  /**
   * Single-use rotation: the old refresh token is atomically consumed
   * (deleted) as the very first step, regardless of what happens next —
   * a device-fingerprint mismatch does not get a second chance to retry
   * with a corrected fingerprint using the same token.
   */
  async refreshTokens(oldRefreshToken: string, deviceFingerprint: string): Promise<TokenPair> {
    const record = await this.refreshTokenStore.consumeAndInvalidate(oldRefreshToken);
    if (!record) {
      throw new UnauthorizedException("Refresh token is invalid, expired, or already used.");
    }

    if (record.deviceFingerprint !== deviceFingerprint) {
      await this.auditService.recordEvent({
        tenantId: record.tenantId,
        actorId: record.userId,
        action: "auth.token.refresh_device_mismatch",
        resourceType: "refresh_token",
        resourceId: record.userId,
        details: {},
      });
      throw new UnauthorizedException("Refresh token is invalid, expired, or already used.");
    }

    const accessToken = await this.mintAccessToken(record.userId, record.tenantId, record.roles, false);
    const newRefreshToken = randomBytes(32).toString("hex");
    await this.refreshTokenStore.store(
      newRefreshToken,
      { userId: record.userId, tenantId: record.tenantId, deviceFingerprint, roles: record.roles },
      REFRESH_TOKEN_TTL_SECONDS,
    );

    await this.auditService.recordEvent({
      tenantId: record.tenantId,
      actorId: record.userId,
      action: "auth.token.refreshed",
      resourceType: "refresh_token",
      resourceId: record.userId,
      details: {},
    });

    return { accessToken, refreshToken: newRefreshToken };
  }

  async revoke(refreshToken: string): Promise<void> {
    await this.refreshTokenStore.invalidate(refreshToken);
  }

  private async mintAccessToken(userId: string, tenantId: string, roles: string[], mfaVerified: boolean): Promise<string> {
    const permissions = await this.rbacService.getPermissionsForRoles(tenantId, roles);
    // tid (short form) per this WO's acceptance criteria; tenant_id is
    // NOT also embedded — JwtKeyService.verify() normalizes tid onto
    // tenant_id for every consumer, so there is exactly one source of
    // truth for this claim on the wire, not two that could theoretically
    // disagree.
    return this.keyService.sign({ tid: tenantId, roles, permissions, mfa_verified: mfaVerified }, userId, ACCESS_TOKEN_TTL_SECONDS);
  }
}
