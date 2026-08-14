import { Injectable } from "@nestjs/common";
import type { KmsServicePort } from "../kms-service.port";

// Test/local-dev stand-in. The real AWS KMS-backed implementation is
// WO-015's scope (BYOK Encryption) — this WO only needs the saga to be
// able to call *a* KmsServicePort and correctly compensate if a later
// step fails, not a working AWS integration yet.
@Injectable()
export class InMemoryKmsService implements KmsServicePort {
  readonly createdKeys = new Set<string>();
  private counter = 0;

  async createTenantKey(tenantId: string, dataResidencyRegion: "us" | "eu"): Promise<{ keyArn: string }> {
    this.counter += 1;
    const keyArn = `arn:aws:kms:${dataResidencyRegion === "eu" ? "eu-west-1" : "us-east-1"}:000000000000:key/in-memory-${tenantId}-${this.counter}`;
    this.createdKeys.add(keyArn);
    return { keyArn };
  }

  async deleteTenantKey(keyArn: string): Promise<void> {
    this.createdKeys.delete(keyArn);
  }
}
