# PHI Secondary Validation, Quarantine, and Audit Trail (WO-043)

## What this WO adds on top of WO-016/017/034/035

WO-016 (data classification) and WO-017 (`PhiScrubberService`) already
existed before this WO, and WO-034/035 already wired a two-pass scrub
(field/exact-value, then embedded-substring) into `TelemetryPipelineService`
between tenant enrichment and Kafka publish. This WO does **not**
re-implement any of that — it adds the three pieces that were genuinely
missing:

1. **More PHI patterns.** `phi-patterns.ts` gains ICD-10 diagnosis codes,
   email addresses, and phone numbers (value-shape patterns) plus
   `email`/`phone`/`icd10` field-name patterns, alongside the pre-existing
   SSN/MRN/DOB/diagnosis coverage.
2. **A defense-in-depth secondary validation gate.** `PhiSecondaryValidator`
   re-scans output the primary pass has *already* scrubbed. If it still
   finds PHI-shaped content — or if primary scrubbing itself throws for any
   reason — the event is quarantined to `phi_quarantine_events` instead of
   ever reaching Kafka. This is the literal "never fail open" requirement:
   quarantining is what the pipeline's catch block does, not a fallback
   bolted onto the happy path afterward.
3. **An immutable per-detection audit trail.** `PhiAuditEmitter` writes one
   `audit_events` row (action `phi_detected`) per masked field, via the
   platform's own existing append-only, hash-chained audit log (migration
   005) — reused rather than inventing a parallel audit mechanism.

## A real bug this WO's own AC surfaced (fixed as a prerequisite)

Writing to `audit_events`/`phi_quarantine_events` requires
`app.current_tenant` to be set — both tables carry the same RLS policy and
tenant-context-guard trigger as every other tenant-scoped table (migrations
006/015). `HmacValidationMiddleware` authenticates a telemetry request
*outside* `TenantContextMiddleware` (there's no user JWT to derive tenant
context from for machine-to-machine telemetry), so `app.current_tenant` was
never being set by the time a request reached the ingestion pipeline.

Confirmed by testing directly against Postgres:

```
INSERT INTO telemetry_dead_letter_events (...) ...;
ERROR:  new row violates row-level security policy for table "telemetry_dead_letter_events"
```

This was already a latent bug in the WO-034/041 dead-letter and metrics
write paths (any Kafka failure in production would have hit the same
error) — silently correct only because no environment in this sandbox has
ever exercised that path with a real, unscoped connection end-to-end.
Since this WO adds two MORE writes to the same unscoped path, fixing it
here was a prerequisite, not scope creep: `AdaptersController.processOne`
now acquires its own connection and establishes `app.current_tenant` via
`BEGIN`/`set_config`/`COMMIT`, the same shape `TenantContextMiddleware`
uses for a normal authenticated request, and passes that connection through
to every downstream write (dead-letter, metrics, PHI audit, PHI
quarantine).

## Fixture location

Per the AC, synthetic PHI fixtures (obviously fake data — `Jane Doe`,
`000-00-0000`, `test@example.com`) live at
`backend/test/fixtures/phi/synthetic-phi-events.json`. No real PHI is used
anywhere in this codebase's tests.
