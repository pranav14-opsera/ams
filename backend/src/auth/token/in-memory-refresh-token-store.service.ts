import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import type { RefreshTokenRecord, RefreshTokenStorePort } from "./refresh-token-store.port";

interface Entry {
  record: RefreshTokenRecord;
  expiresAt: number;
}

function tokenKey(tokenPlaintext: string): string {
  // Matches this WO's own specified Redis key pattern
  // (refresh_token:{sha256(token)}) — the plaintext token itself is
  // never used as a lookup key or stored anywhere, only its hash, same
  // reasoning as never storing a password in plaintext: a leaked store
  // dump must not hand out usable tokens.
  return createHash("sha256").update(tokenPlaintext).digest("hex");
}

@Injectable()
export class InMemoryRefreshTokenStore implements RefreshTokenStorePort {
  private readonly entries = new Map<string, Entry>();

  async store(tokenPlaintext: string, record: RefreshTokenRecord, ttlSeconds: number): Promise<void> {
    this.entries.set(tokenKey(tokenPlaintext), { record, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async consumeAndInvalidate(tokenPlaintext: string): Promise<RefreshTokenRecord | null> {
    const key = tokenKey(tokenPlaintext);
    const entry = this.entries.get(key);
    this.entries.delete(key); // single-use: gone regardless of whether it was valid, expired, or absent
    if (!entry || Date.now() >= entry.expiresAt) {
      return null;
    }
    return entry.record;
  }

  async invalidate(tokenPlaintext: string): Promise<void> {
    this.entries.delete(tokenKey(tokenPlaintext));
  }
}
