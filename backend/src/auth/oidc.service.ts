import { Injectable, UnauthorizedException } from "@nestjs/common";
import { Issuer } from "openid-client";
import { EncryptionService } from "../encryption/encryption.service";
import type { TenantSsoConfig } from "./sso-config.repository";
import type { SsoIdentity } from "./saml.service";

const GROUP_CLAIM_NAMES = ["groups", "roles", "https://schemas.platform/groups"];

@Injectable()
export class OidcService {
  constructor(private readonly encryptionService: EncryptionService) {}

  /**
   * Discovers the tenant's IdP (real network call to their discovery
   * document — genuinely exercised in this WO's integration test against
   * a real local mock OIDC provider, not stubbed), exchanges the
   * authorization code, and validates the returned id_token. Any failure
   * (network, signature, expiry, audience mismatch) collapses to the
   * same generic UnauthorizedException — this WO's acceptance criteria
   * require that a failed exchange never reveals *why*.
   */
  async validate(config: TenantSsoConfig, code: string, callbackUrl: string): Promise<SsoIdentity> {
    if (!config.oidcDiscoveryUrl || !config.oidcClientId || !config.oidcClientSecret) {
      throw new UnauthorizedException("SSO validation failed.");
    }

    let claims: Record<string, unknown>;
    try {
      const clientSecretBuffer = await this.encryptionService.decrypt(config.tenantId, config.oidcClientSecret);
      const issuer = await Issuer.discover(config.oidcDiscoveryUrl);
      const client = new issuer.Client({
        client_id: config.oidcClientId,
        client_secret: clientSecretBuffer.toString("utf8"),
        redirect_uris: [callbackUrl],
        response_types: ["code"],
      });

      const tokenSet = await client.callback(callbackUrl, { code });
      claims = tokenSet.claims() as Record<string, unknown>;
    } catch {
      throw new UnauthorizedException("SSO validation failed.");
    }

    if (typeof claims.sub !== "string") {
      throw new UnauthorizedException("SSO validation failed.");
    }

    return {
      subject: claims.sub,
      email: typeof claims.email === "string" ? claims.email : null,
      groups: this.extractGroups(claims),
    };
  }

  private extractGroups(claims: Record<string, unknown>): string[] {
    for (const claimName of GROUP_CLAIM_NAMES) {
      const raw = claims[claimName];
      if (raw === undefined) continue;
      if (Array.isArray(raw)) return raw.map(String);
      if (typeof raw === "string") return raw.split(",").map((g) => g.trim()).filter(Boolean);
    }
    return [];
  }
}
