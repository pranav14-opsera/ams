# Audit Log Query API with Async Export (WO-047)

## Architecture

- **`GET /api/v1/audit/logs`** (`AuditLogController` → `AuditLogQueryService` → `AuditLogQueryRepository`) — keyset-paginated, filtered reads over WO-045's `audit_events` table via the existing `(tenant_id, occurred_at, action, data_classification)` composite index.
- **`POST /api/v1/audit/exports` / `GET /api/v1/audit/exports/:id`** (`AuditExportController` → `AuditExportService` → `AuditExportJobRepository` + `AuditExportWorkerService`) — an async job (migration 040's `audit_export_jobs` state machine: pending → processing → completed/failed) that streams matching rows to storage and returns a pre-signed download URL.

## RBAC: a new `@RequireAnyPermission` decorator

`GET /api/v1/audit/logs` is shared by roles whose access comes from **different** permissions — per the existing RBAC matrix (migration 024): `compliance_officer` holds only `audit_access:logs:view_org`, `team_lead` holds only `audit_access:logs:view_team`, `platform_admin` holds both. `RbacGuard`'s existing `@RequirePermission(...)` only expresses a single required permission, so this WO adds `@RequireAnyPermission([...])` — the caller must hold at least one of the listed permissions. This is additive: every existing `@RequirePermission` route is unaffected (see `test/rbac/rbac.guard.test.ts`'s new WO-047 cases).

`AuditLogQueryService` then resolves WHICH permission the caller actually holds to decide scope: `view_org` (or both) → unrestricted; `view_team`-only → restricted to the actor_ids of every member of the caller's own team(s) (`audit_events` has no `team_id` column, so this is done by resolving team membership first, then filtering by `actor_id`, rather than a join the schema doesn't support). A team_lead who belongs to no team at all is restricted to just their own actions, never silently widened to the whole tenant.

`POST/GET /api/v1/audit/exports` uses the existing `reporting:audit_summary:export` permission as-is (granted only to `compliance_officer` in the existing seed) — this WO does not expand that grant to `platform_admin`; that would be a product decision for the RBAC matrix itself (WO-023), not something to silently widen here.

## Storage: no real S3 in this sandbox

Mirrors WO-015's `KmsServicePort` precedent exactly: `ExportStoragePort` (`uploadNdjson`/`getPresignedDownloadUrl`/`deleteExport`) is the production-shaped interface, with `LocalFilesystemExportStorageService` as the one concrete adapter — this sandbox has no AWS credentials or reachable S3 endpoint. It genuinely streams files to disk and generates a real HMAC-signed, time-limited (1 hour, per the AC) token so "pre-signed URL" behavior — a URL that's valid only until a fixed expiry, tamper-evident — is actually exercised, not faked as a bare file path. A real S3 adapter is a drop-in later (`uploadNdjson` → multipart upload, `getPresignedDownloadUrl` → `getSignedUrl("getObject", ...)`) behind the same `EXPORT_STORAGE_SERVICE` token.

## No real background job queue

There is no BullMQ/SQS/etc. anywhere in this codebase. `AuditExportService.requestExport()` creates the job row and invokes `AuditExportWorkerService.run()` fire-and-forget (not awaited) — the controller returns 202 immediately, and the worker acquires its **own** Postgres connection (never the request's `req.tenantDbClient`, which is released the moment the HTTP response finishes) and establishes `app.current_tenant` itself, the same shape `AdaptersController` (WO-043) uses for its own outside-the-request-lifecycle path. This is a legitimate choice for this sandbox's single-instance deployment, not a Kafka-style simulated stand-in — a horizontally-scaled deployment would swap this for a real queue consumer without changing the export logic itself.

## Two real bugs found via testing

1. **Audit-of-export write raced the job's "completed" status.** The worker originally marked the job `completed` in the database, THEN recorded the `audit.exported` event. A test polling `GET /exports/:id` for `status: completed` could observe that status and tear down its Postgres pool while the audit-event write was still in flight, throwing `Cannot use a pool after calling end on the pool`. Fixed by recording the audit event **before** marking the job completed — a caller must never observe `completed` while a promised side effect (the audit trail this WO's own AC requires) is still pending.
2. **A UUID `job_id` inside `change_details` could come back partially masked.** `change_details` goes through the same free-text PHI-scrub pass (`PhiScrubberService.scrubEmbeddedText`, WO-017/043/044) as every other audit event's payload — a substring-level scan needed to catch PHI embedded mid-sentence. A raw UUID string can contain a digit run that happens to match the MRN/DOB value-shape patterns, so parts of it got masked. Fixed by NOT duplicating `job_id` into `change_details` (it's already carried as the event's own `resource_id`/`correlation_id`, which are never scrubbed) rather than changing the scrubber — over-redaction on a truly PHI-containing field is this codebase's documented safe default, so the fix is "don't put pure identifiers through this pass," not "make the pass smarter about UUIDs." A regression test in `phi-scrubber.service.test.ts` documents this as expected scrubber behavior.

## Performance: AC's literal 500K-1M-record scale vs. what's automated here

Seeding 500K-1M real, hash-chained rows sequentially (each insert going through WO-045's per-tenant advisory lock + trigger) would take on the order of tens of minutes — not a reasonable automated test. The automated performance test seeds 10,000 real rows (reusing WO-045's `seedAuditEventFixtures`) and measured, on this sandbox's hardware:

```
seeded 10,000 rows in 6.5s
100-row page query: 20ms
count query: 14ms
```

Both comfortably under the AC's 5-second budget. Keyset pagination means query cost is dominated by the index seek (`(tenant_id, occurred_at, action, data_classification)`), not the total row count, so this is expected to hold at 500K+ rows too — but that scale should be confirmed against a real staging environment before being treated as a production guarantee, the same caveat WO-044's `LOAD_TEST_RESULTS.md` already established for this codebase's other performance ACs.

The export path's "1M records within 60s" target was not separately load-tested at that scale for the same reason; the export worker streams via the same keyset-paginated repository method the query endpoint uses, so its per-row cost is the same order of magnitude — a full-scale validation is a staging exercise, not part of this automated suite.
