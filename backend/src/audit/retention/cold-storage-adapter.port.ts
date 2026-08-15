export const COLD_STORAGE_ADAPTER = "COLD_STORAGE_ADAPTER";

export interface UploadedArchive {
  storageKey: string;
  checksum: string;
  rowCount: number;
}

// Genuinely external (S3 Glacier/Infrequent-Access in production — see
// AUDIT_RETENTION.md for the full reconciliation of why this sandbox has
// no real S3/Athena access). Shaped so a real S3 adapter is a drop-in
// later: uploadPartitionArchive maps onto a multipart upload plus a
// server-side checksum (S3 already computes and returns one), readArchive
// onto a ranged/streamed getObject, deleteArchive onto a plain
// deleteObject — same "one concrete adapter now, a cloud one is follow-up
// work" shape as KmsServicePort (WO-015) and ExportStoragePort (WO-047).
//
// Real Parquet/Athena is also unavailable here (no columnar-format library
// installed, no network access to add one, no Athena endpoint) — this
// sandbox's "cold storage format" is NDJSON, the same substitute
// ExportStoragePort already established for exports. A real adapter would
// write Parquet instead; the interface itself is format-agnostic (callers
// only ever get rows back out, never a raw byte format).
export interface ColdStorageAdapterPort {
  /** Streams every row of one archived partition to cold storage. Returns the storage key, a SHA-256 checksum of the archived content, and the row count actually written. */
  uploadPartitionArchive(partitionName: string, rows: AsyncIterable<Record<string, unknown>>): Promise<UploadedArchive>;

  /** Recomputes the SHA-256 checksum of the archive currently at storageKey and compares it against the expected value recorded at upload time — the tiering job's own "verify the S3 object exists and matches" step before it is safe to drop the Postgres partition. */
  verifyChecksum(storageKey: string, expectedChecksum: string): Promise<boolean>;

  /** Reads every row back out of a previously archived partition, in the same order it was written. */
  readArchive(storageKey: string): AsyncIterable<Record<string, unknown>>;

  /** Deletes a previously archived partition's cold-storage object — the purge job's action once every tenant's retention period for that period has elapsed. */
  deleteArchive(storageKey: string): Promise<void>;
}
