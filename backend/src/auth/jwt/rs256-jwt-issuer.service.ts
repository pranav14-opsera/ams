import { Injectable } from "@nestjs/common";
import * as jwt from "jsonwebtoken";
import type { JwtIssuerPort, PlatformJwtClaims } from "./jwt-issuer.port";

const DEFAULT_EXPIRY_SECONDS = 3600; // 1 hour access token, matching typical SSO session-bootstrap lifetimes

@Injectable()
export class Rs256JwtIssuerService implements JwtIssuerPort {
  constructor(private readonly privateKeyPem: string) {}

  async issue(claims: PlatformJwtClaims, expiresInSeconds: number = DEFAULT_EXPIRY_SECONDS): Promise<string> {
    return jwt.sign({ tenant_id: claims.tenant_id, groups: claims.groups ?? [], idp_type: claims.idp_type }, this.privateKeyPem, {
      algorithm: "RS256",
      subject: claims.sub,
      expiresIn: expiresInSeconds,
    });
  }
}
