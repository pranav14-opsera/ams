import { Injectable } from "@nestjs/common";
import type { JwtVerifierPort, VerifiedClaims } from "../../common/jwt/jwt-verifier.port";
import { JwtKeyService } from "./jwt-key.service";

// Replaces WO-013's static-single-PEM Rs256JwtVerifier as the JWT_VERIFIER
// provider (see auth.module.ts) — same JwtVerifierPort contract, so
// TenantContextMiddleware needs no changes at all to benefit from
// current+overlapping multi-key verification during a rotation window.
@Injectable()
export class MultiKeyJwtVerifier implements JwtVerifierPort {
  constructor(private readonly keyService: JwtKeyService) {}

  async verify(token: string): Promise<VerifiedClaims> {
    return this.keyService.verify(token);
  }
}
