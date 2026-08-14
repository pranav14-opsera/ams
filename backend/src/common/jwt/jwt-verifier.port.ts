export interface VerifiedClaims {
  sub: string;
  tenant_id: string;
  [claim: string]: unknown;
}

export class JwtVerificationError extends Error {}

export interface JwtVerifierPort {
  /** Throws JwtVerificationError for any invalid, expired, or malformed token. */
  verify(token: string): Promise<VerifiedClaims>;
}

export const JWT_VERIFIER = "JWT_VERIFIER";
