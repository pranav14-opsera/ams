import { Inject, Injectable } from "@nestjs/common";
import { JWT_VERIFIER, type JwtVerifierPort } from "../common/jwt/jwt-verifier.port";

export interface WsIdentity {
  tenantId: string;
  userId: string;
  roles: string[];
}

export class WsAuthenticationError extends Error {}

/**
 * WebSocket handshakes carry no Authorization header (most browser
 * WebSocket clients can't set one) — the JWT travels as a `token` query
 * parameter instead, the standard workaround, verified with the SAME
 * RS256/JWKS-rotation-aware verifier (WO-019's MultiKeyJwtVerifier) the
 * REST API already uses. No second, independent JWT verification
 * implementation, same reasoning GATEWAY.md already applies elsewhere.
 */
@Injectable()
export class WsAuthService {
  constructor(@Inject(JWT_VERIFIER) private readonly jwtVerifier: JwtVerifierPort) {}

  async authenticate(requestUrl: string | undefined): Promise<WsIdentity> {
    const token = this.extractToken(requestUrl);
    if (!token) {
      throw new WsAuthenticationError("Missing token query parameter.");
    }

    let claims;
    try {
      claims = await this.jwtVerifier.verify(token);
    } catch {
      throw new WsAuthenticationError("Invalid or expired token.");
    }

    if (!claims.tenant_id) {
      throw new WsAuthenticationError("Token missing tenant_id claim.");
    }

    return {
      tenantId: claims.tenant_id,
      userId: claims.sub,
      roles: Array.isArray(claims.roles) ? (claims.roles as string[]) : [],
    };
  }

  private extractToken(requestUrl: string | undefined): string | null {
    if (!requestUrl) return null;
    try {
      const url = new URL(requestUrl, "http://localhost");
      return url.searchParams.get("token");
    } catch {
      return null;
    }
  }
}
