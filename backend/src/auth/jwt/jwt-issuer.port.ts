export const JWT_ISSUER = "JWT_ISSUER";

export interface PlatformJwtClaims {
  sub: string; // user id
  tenant_id: string;
  groups?: string[];
  idp_type: "saml" | "oidc";
}

// Counterpart to Rs256JwtVerifier (WO-013, common/jwt/) — that one only
// verifies (the public key comes from KMS's GetPublicKey in deployed
// environments). This is the signing side the Auth Service actually
// needs to mint tokens after a successful SSO exchange. In production
// this signs via AWS KMS's asymmetric Sign API against the same
// jwt-signing key (infrastructure/terraform/kms/jwt-signing.tf, WO-003) —
// not implemented here, same connector-gap pattern as this codebase's
// other AWS-KMS-shaped gaps (WO-012's cosign signing key, WO-015's KMS
// adapter). Rs256JwtIssuerService below is the real, functional
// dev/test/single-instance-deployment implementation: it signs locally
// with an RSA private key rather than calling out to KMS.
export interface JwtIssuerPort {
  issue(claims: PlatformJwtClaims, expiresInSeconds?: number): Promise<string>;
}
