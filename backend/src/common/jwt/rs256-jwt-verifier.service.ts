import { Injectable } from "@nestjs/common";
import * as jwt from "jsonwebtoken";
import { JwtVerificationError, type JwtVerifierPort, type VerifiedClaims } from "./jwt-verifier.port";

// Verifies tokens signed by the platform's JWT signing KMS key
// (infrastructure/terraform/kms/jwt-signing.tf, WO-003 — RSA_2048,
// RS256). Full token *issuance* (SSO/MFA/session management) is WO-018's
// scope; this only verifies what WO-013's tenant context middleware
// needs. The public key is injected as a PEM string — in a deployed
// environment that PEM comes from KMS's GetPublicKey (no AWS connector
// in this environment to fetch it live, so it's config here, same
// connector-gap pattern as the rest of this pipeline).
@Injectable()
export class Rs256JwtVerifier implements JwtVerifierPort {
  constructor(private readonly publicKeyPem: string) {}

  async verify(token: string): Promise<VerifiedClaims> {
    let decoded: unknown;
    try {
      decoded = jwt.verify(token, this.publicKeyPem, { algorithms: ["RS256"] });
    } catch (err) {
      throw new JwtVerificationError(err instanceof Error ? err.message : "invalid token");
    }

    if (typeof decoded !== "object" || decoded === null) {
      throw new JwtVerificationError("token payload is not an object");
    }
    const claims = decoded as Record<string, unknown>;
    if (typeof claims.sub !== "string" || typeof claims.tenant_id !== "string") {
      throw new JwtVerificationError("token is missing required sub/tenant_id claims");
    }

    return claims as VerifiedClaims;
  }
}
