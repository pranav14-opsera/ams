export const EXPORT_STORAGE_SERVICE = "EXPORT_STORAGE_SERVICE";

export interface UploadedExport {
  /** Storage-layer key/path — an S3 object key in production, a local file path for the in-sandbox stand-in. Never returned to callers outside this domain; only the pre-signed URL is. */
  storageKey: string;
  sizeBytes: number;
}

// Genuinely external (AWS S3 in production — see AUDIT_EXPORT_QUERY_API.md
// for the full reconciliation of why this sandbox has no real S3 access).
// Shaped so a real S3 adapter is a drop-in later: uploadNdjson maps onto a
// multipart upload, getPresignedDownloadUrl onto S3's own
// getSignedUrl("getObject", ...), same as KmsServicePort's own precedent
// (WO-015) for exactly this class of "real cloud dependency, one concrete
// adapter implemented, a second is follow-up work" situation.
export interface ExportStoragePort {
  /** Streams newline-delimited JSON rows to storage under a tenant/job-scoped key. Returns the storage key and final byte size. */
  uploadNdjson(tenantId: string, jobId: string, rows: AsyncIterable<Record<string, unknown>>): Promise<UploadedExport>;

  /** A time-limited download URL for a previously uploaded export — 1-hour expiry per this WO's own AC. */
  getPresignedDownloadUrl(storageKey: string): Promise<{ url: string; expiresAt: Date }>;

  /** Deletes a previously uploaded export — the AC's 7-day lifecycle policy substitute where no real S3 lifecycle rule can be configured. */
  deleteExport(storageKey: string): Promise<void>;
}
