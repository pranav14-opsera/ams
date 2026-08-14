import { Injectable } from "@nestjs/common";
import { createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";
import * as jwt from "jsonwebtoken";
import { JwtVerificationError, type VerifiedClaims } from "../../common/jwt/jwt-verifier.port";

export interface JwtKeyGeneration {
  kid: string;
  publicKeyPem: string;
  privateKeyPem: string;
  createdAt: Date;
  /** Set once a newer generation becomes current — null means this IS the current signing key. */
  supersededAt: Date | null;
}

export interface PublicJwk {
  kty: "RSA";
  kid: string;
  use: "sig";
  alg: "RS256";
  n: string;
  e: string;
}

const ROTATE_AFTER_DAYS = 23; // implementation step: "generates a new key pair... when the current key exceeds 23 days" — buffer before the 30-day policy so the 7-day overlap always fully completes before the NEXT rotation would otherwise need it
const OVERLAP_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

// Manages RS256 key GENERATIONS with rotation + overlap, real crypto
// throughout (node:crypto RSA generation, jsonwebtoken RS256 sign/verify)
// — not simulated. Production signs via Cloud KMS's asymmetric Sign API
// (this WO's own description: "JWT signing keys must be managed in
// Cloud KMS"); not implemented here, same connector-gap pattern as this
// codebase's other AWS/cloud-KMS-shaped gaps (WO-012's cosign key,
// WO-015's KMS adapter, WO-018's JwtIssuerPort). What IS real here is the
// generation/overlap/rotation *logic* — the part that's genuinely
// testable and reusable regardless of which backend eventually signs.
@Injectable()
export class JwtKeyService {
  private generations: JwtKeyGeneration[] = [];

  constructor() {
    this.generations.push(this.generateNewGeneration());
  }

  currentKid(): string {
    return this.generations[0].kid;
  }

  sign(claims: Record<string, unknown>, subject: string, expiresInSeconds: number): string {
    const current = this.generations[0];
    return jwt.sign(claims, current.privateKeyPem, {
      algorithm: "RS256",
      subject,
      expiresIn: expiresInSeconds,
      keyid: current.kid,
      jwtid: randomUUID(),
    });
  }

  /**
   * Verifies against whichever active generation's kid matches the token
   * header, falling back to trying every active key if the header has
   * none (defense-in-depth; our own sign() always sets one).
   *
   * Accepts an optional `now` — found via testing that without one,
   * "activeness" always checks against the REAL wall clock, which makes
   * it impossible to deterministically test (or reason about) what a
   * caller sees once a key generation's overlap window has elapsed:
   * rotateIfDue(simulatedFutureNow) can move a generation into the past
   * relative to that simulated timeline, but verify() calling
   * activeGenerations() with a *different*, real "now" would never agree
   * that any time had actually passed. Threading the same `now` through
   * both keeps rotation and verification on one consistent timeline.
   */
  verify(token: string, now: Date = new Date()): VerifiedClaims {
    const decodedHeader = jwt.decode(token, { complete: true })?.header;
    const kid = decodedHeader?.kid;
    const candidates = kid ? this.activeGenerations(now).filter((g) => g.kid === kid) : this.activeGenerations(now);

    if (candidates.length === 0) {
      throw new JwtVerificationError("no active signing key matches this token's kid");
    }

    let lastError: unknown;
    for (const generation of candidates) {
      try {
        const decoded = jwt.verify(token, generation.publicKeyPem, { algorithms: ["RS256"] });
        if (typeof decoded !== "object" || decoded === null) {
          throw new JwtVerificationError("token payload is not an object");
        }
        const claims = decoded as Record<string, unknown>;
        if (typeof claims.sub !== "string" || typeof claims.tenant_id !== "string" && typeof claims.tid !== "string") {
          throw new JwtVerificationError("token is missing required sub/tenant claims");
        }
        // Normalize the short-form `tid` claim (this WO's acceptance
        // criteria) onto `tenant_id` too, so every existing consumer of
        // VerifiedClaims (TenantContextMiddleware, WO-013) keeps working
        // unchanged against tokens minted by this newer token service.
        return { ...claims, tenant_id: (claims.tenant_id as string) ?? (claims.tid as string) } as VerifiedClaims;
      } catch (err) {
        lastError = err;
      }
    }
    throw new JwtVerificationError(lastError instanceof Error ? lastError.message : "invalid token");
  }

  /** Public keys for the JWKS endpoint (current + overlapping, never retired). */
  activePublicJwks(now: Date = new Date()): PublicJwk[] {
    return this.activeGenerations(now).map((g) => {
      const publicKeyObject = createPublicKey(g.publicKeyPem);
      const jwk = publicKeyObject.export({ format: "jwk" }) as { n: string; e: string };
      return { kty: "RSA", kid: g.kid, use: "sig", alg: "RS256", n: jwk.n, e: jwk.e };
    });
  }

  /** Called by an external scheduler (daily, per this WO's own implementation step) — mirrors the pattern of every other "not wired to a live cron here" job in this codebase (migration 007/016's partition/deletion jobs). Returns true if a rotation actually happened. */
  rotateIfDue(now: Date = new Date()): boolean {
    const current = this.generations[0];
    const ageDays = (now.getTime() - current.createdAt.getTime()) / DAY_MS;
    if (ageDays < ROTATE_AFTER_DAYS) {
      return false;
    }

    current.supersededAt = now;
    this.generations.unshift(this.generateNewGeneration(now));
    this.pruneRetired(now);
    return true;
  }

  private activeGenerations(now: Date = new Date()): JwtKeyGeneration[] {
    return this.generations.filter((g) => g.supersededAt === null || now.getTime() - g.supersededAt.getTime() <= OVERLAP_DAYS * DAY_MS);
  }

  private pruneRetired(now: Date): void {
    this.generations = this.generations.filter((g) => g.supersededAt === null || now.getTime() - g.supersededAt.getTime() <= OVERLAP_DAYS * DAY_MS);
  }

  private generateNewGeneration(createdAt: Date = new Date()): JwtKeyGeneration {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    return { kid: randomUUID(), publicKeyPem: publicKey, privateKeyPem: privateKey, createdAt, supersededAt: null };
  }
}
