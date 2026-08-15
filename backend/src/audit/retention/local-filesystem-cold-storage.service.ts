import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Injectable } from "@nestjs/common";
import type { ColdStorageAdapterPort, UploadedArchive } from "./cold-storage-adapter.port";

const COLD_STORAGE_DIR = process.env.AUDIT_COLD_STORAGE_LOCAL_DIR ?? join(tmpdir(), "ams-audit-cold-storage");

/**
 * Local-filesystem stand-in for a real S3 (Glacier/Infrequent-Access)
 * adapter — same class of gap as WO-047's LocalFilesystemExportStorageService,
 * genuinely streaming and reading back real files rather than stubbing.
 * See AUDIT_RETENTION.md.
 */
@Injectable()
export class LocalFilesystemColdStorageService implements ColdStorageAdapterPort {
  async uploadPartitionArchive(partitionName: string, rows: AsyncIterable<Record<string, unknown>>): Promise<UploadedArchive> {
    await mkdir(COLD_STORAGE_DIR, { recursive: true });
    const storageKey = join(COLD_STORAGE_DIR, `${partitionName}.ndjson`);
    const handle = await open(storageKey, "w");
    const hash = createHash("sha256");
    let rowCount = 0;
    try {
      for await (const row of rows) {
        const line = `${JSON.stringify(row)}\n`;
        hash.update(line);
        await handle.write(line);
        rowCount++;
      }
    } finally {
      await handle.close();
    }
    return { storageKey, checksum: hash.digest("hex"), rowCount };
  }

  async verifyChecksum(storageKey: string, expectedChecksum: string): Promise<boolean> {
    const hash = createHash("sha256");
    try {
      for await (const row of this.readArchive(storageKey)) {
        hash.update(`${JSON.stringify(row)}\n`);
      }
    } catch {
      return false;
    }
    return hash.digest("hex") === expectedChecksum;
  }

  async *readArchive(storageKey: string): AsyncIterable<Record<string, unknown>> {
    const rl = createInterface({ input: createReadStream(storageKey, { encoding: "utf8" }) });
    for await (const line of rl) {
      if (line.length === 0) continue;
      yield JSON.parse(line);
    }
  }

  async deleteArchive(storageKey: string): Promise<void> {
    await rm(storageKey, { force: true });
  }
}
