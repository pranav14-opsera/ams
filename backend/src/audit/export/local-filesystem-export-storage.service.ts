import { createHmac, randomBytes } from "node:crypto";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Injectable } from "@nestjs/common";
import type { ExportStoragePort, UploadedExport } from "./export-storage.port";

const PRESIGNED_URL_TTL_MS = 60 * 60 * 1000; // AC: "1-hour expiry"
const EXPORT_DIR = process.env.AUDIT_EXPORT_LOCAL_DIR ?? join(tmpdir(), "ams-audit-exports");
const HMAC_SECRET = process.env.AUDIT_EXPORT_URL_SECRET ?? randomBytes(32).toString("hex");

/**
 * Local-filesystem stand-in for a real S3 adapter — this sandbox has no
 * AWS access (no credentials, no reachable S3 endpoint), the same class
 * of gap as WO-015's KmsServicePort only shipping an in-memory adapter.
 * Writes real files to disk (not a stub — genuinely streams and reads
 * back), and generates a real HMAC-signed, time-limited token so
 * "pre-signed URL" behavior (a URL that is only valid until a fixed
 * expiry, tamper-evident) is genuinely exercised rather than faked as a
 * bare file path. See AUDIT_EXPORT_QUERY_API.md.
 */
@Injectable()
export class LocalFilesystemExportStorageService implements ExportStoragePort {
  async uploadNdjson(tenantId: string, jobId: string, rows: AsyncIterable<Record<string, unknown>>): Promise<UploadedExport> {
    await mkdir(EXPORT_DIR, { recursive: true });
    const storageKey = join(EXPORT_DIR, `${tenantId}__${jobId}.ndjson`);
    const handle = await open(storageKey, "w");
    let sizeBytes = 0;
    try {
      for await (const row of rows) {
        const line = `${JSON.stringify(row)}\n`;
        sizeBytes += Buffer.byteLength(line);
        await handle.write(line);
      }
    } finally {
      await handle.close();
    }
    return { storageKey, sizeBytes };
  }

  async getPresignedDownloadUrl(storageKey: string): Promise<{ url: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + PRESIGNED_URL_TTL_MS);
    const signature = this.sign(storageKey, expiresAt.getTime());
    const url = `file://${storageKey}?expires=${expiresAt.getTime()}&signature=${signature}`;
    return { url, expiresAt };
  }

  /** Verifies a presigned URL's signature and expiry — the local stand-in's equivalent of S3 itself validating a getSignedUrl request. */
  verifyPresignedUrl(url: string): boolean {
    const parsed = new URL(url);
    const storageKey = url.slice("file://".length, url.indexOf("?"));
    const expires = Number(parsed.searchParams.get("expires"));
    const signature = parsed.searchParams.get("signature");
    if (!signature || Number.isNaN(expires)) return false;
    if (Date.now() > expires) return false;
    return signature === this.sign(storageKey, expires);
  }

  async deleteExport(storageKey: string): Promise<void> {
    await rm(storageKey, { force: true });
  }

  async exists(storageKey: string): Promise<boolean> {
    try {
      await stat(storageKey);
      return true;
    } catch {
      return false;
    }
  }

  private sign(storageKey: string, expiresAtMs: number): string {
    return createHmac("sha256", HMAC_SECRET).update(`${storageKey}|${expiresAtMs}`).digest("hex");
  }
}
