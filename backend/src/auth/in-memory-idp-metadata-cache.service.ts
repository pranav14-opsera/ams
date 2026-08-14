import { Injectable } from "@nestjs/common";
import type { IdpMetadataCachePort } from "./idp-metadata-cache.port";

interface Entry {
  value: string;
  expiresAt: number;
}

@Injectable()
export class InMemoryIdpMetadataCache implements IdpMetadataCachePort {
  private readonly store = new Map<string, Entry>();
  private readonly assertionIds = new Map<string, number>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async checkAndRecordAssertionId(assertionId: string, ttlSeconds: number): Promise<boolean> {
    const now = Date.now();
    const existingExpiry = this.assertionIds.get(assertionId);
    if (existingExpiry !== undefined && now < existingExpiry) {
      return true; // replay
    }
    this.assertionIds.set(assertionId, now + ttlSeconds * 1000);
    return false;
  }
}
