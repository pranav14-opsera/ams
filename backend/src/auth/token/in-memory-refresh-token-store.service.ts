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
  private readonly keysByUser = new Map<string, Set<string>>();
  private readonly keysBySession = new Map<string, Set<string>>();

  async store(tokenPlaintext: string, record: RefreshTokenRecord, ttlSeconds: number): Promise<void> {
    const key = tokenKey(tokenPlaintext);
    this.entries.set(key, { record, expiresAt: Date.now() + ttlSeconds * 1000 });
    this.indexAdd(this.keysByUser, record.userId, key);
    this.indexAdd(this.keysBySession, record.sessionId, key);
  }

  async consumeAndInvalidate(tokenPlaintext: string): Promise<RefreshTokenRecord | null> {
    const key = tokenKey(tokenPlaintext);
    const entry = this.entries.get(key);
    this.removeKey(key, entry?.record); // single-use: gone regardless of whether it was valid, expired, or absent
    if (!entry || Date.now() >= entry.expiresAt) {
      return null;
    }
    return entry.record;
  }

  async invalidate(tokenPlaintext: string): Promise<void> {
    const key = tokenKey(tokenPlaintext);
    const entry = this.entries.get(key);
    this.removeKey(key, entry?.record);
  }

  async invalidateAllForUser(userId: string): Promise<void> {
    const keys = this.keysByUser.get(userId);
    if (!keys) return;
    for (const key of [...keys]) {
      const entry = this.entries.get(key);
      this.removeKey(key, entry?.record);
    }
  }

  async invalidateForSession(sessionId: string): Promise<void> {
    const keys = this.keysBySession.get(sessionId);
    if (!keys) return;
    for (const key of [...keys]) {
      const entry = this.entries.get(key);
      this.removeKey(key, entry?.record);
    }
  }

  private indexAdd(index: Map<string, Set<string>>, indexKey: string, key: string): void {
    const set = index.get(indexKey) ?? new Set<string>();
    set.add(key);
    index.set(indexKey, set);
  }

  private removeKey(key: string, record: RefreshTokenRecord | undefined): void {
    this.entries.delete(key);
    if (record) {
      this.keysByUser.get(record.userId)?.delete(key);
      this.keysBySession.get(record.sessionId)?.delete(key);
    }
  }
}
