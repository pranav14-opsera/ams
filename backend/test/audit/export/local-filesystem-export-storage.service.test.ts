import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { LocalFilesystemExportStorageService } from "../../../src/audit/export/local-filesystem-export-storage.service";

async function* rows(items: Record<string, unknown>[]) {
  for (const item of items) yield item;
}

test("uploadNdjson writes real newline-delimited JSON to disk and reports the byte size", async () => {
  const storage = new LocalFilesystemExportStorageService();
  const tenantId = randomUUID();
  const jobId = randomUUID();

  const uploaded = await storage.uploadNdjson(tenantId, jobId, rows([{ a: 1 }, { b: 2 }]));

  assert.ok(await storage.exists(uploaded.storageKey));
  assert.ok(uploaded.sizeBytes > 0);

  await storage.deleteExport(uploaded.storageKey);
});

test("getPresignedDownloadUrl returns a URL that verifies successfully and expires in ~1 hour", async () => {
  const storage = new LocalFilesystemExportStorageService();
  const tenantId = randomUUID();
  const jobId = randomUUID();
  const uploaded = await storage.uploadNdjson(tenantId, jobId, rows([{ a: 1 }]));

  const before = Date.now();
  const presigned = await storage.getPresignedDownloadUrl(uploaded.storageKey);
  const after = Date.now();

  assert.ok(storage.verifyPresignedUrl(presigned.url), "a freshly generated presigned URL must verify");
  const ttlMs = presigned.expiresAt.getTime() - before;
  assert.ok(ttlMs > 55 * 60 * 1000 && ttlMs <= 60 * 60 * 1000 + (after - before), `expiry should be ~1 hour out, got ${ttlMs}ms`);

  await storage.deleteExport(uploaded.storageKey);
});

test("verifyPresignedUrl rejects a tampered signature", async () => {
  const storage = new LocalFilesystemExportStorageService();
  const tenantId = randomUUID();
  const jobId = randomUUID();
  const uploaded = await storage.uploadNdjson(tenantId, jobId, rows([{ a: 1 }]));
  const presigned = await storage.getPresignedDownloadUrl(uploaded.storageKey);

  const tampered = presigned.url.replace(/signature=[a-f0-9]+/, "signature=0000000000000000000000000000000000000000000000000000000000000000");
  assert.equal(storage.verifyPresignedUrl(tampered), false);

  await storage.deleteExport(uploaded.storageKey);
});

test("verifyPresignedUrl rejects an expired URL", async () => {
  const storage = new LocalFilesystemExportStorageService();
  const tenantId = randomUUID();
  const jobId = randomUUID();
  const uploaded = await storage.uploadNdjson(tenantId, jobId, rows([{ a: 1 }]));
  const presigned = await storage.getPresignedDownloadUrl(uploaded.storageKey);

  const expiredUrl = presigned.url.replace(/expires=\d+/, `expires=${Date.now() - 1000}`);
  assert.equal(storage.verifyPresignedUrl(expiredUrl), false);

  await storage.deleteExport(uploaded.storageKey);
});

test("deleteExport removes the file so it no longer exists", async () => {
  const storage = new LocalFilesystemExportStorageService();
  const tenantId = randomUUID();
  const jobId = randomUUID();
  const uploaded = await storage.uploadNdjson(tenantId, jobId, rows([{ a: 1 }]));
  assert.ok(await storage.exists(uploaded.storageKey));

  await storage.deleteExport(uploaded.storageKey);
  assert.equal(await storage.exists(uploaded.storageKey), false);
});
