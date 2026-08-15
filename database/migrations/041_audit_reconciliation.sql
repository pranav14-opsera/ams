-- WO-048: daily/monthly audit reconciliation infrastructure.
--
-- "Source system" counts, substituted: the AC asks to compare "Kafka
-- topic offsets or TimescaleDB aggregates" against audit_events counts.
-- This sandbox has neither a reachable Kafka broker nor TimescaleDB
-- (both confirmed repeatedly elsewhere in this codebase — see
-- TELEMETRY_PIPELINE.md, TIMESCALEDB_SCHEMA.md). The genuine, meaningful
-- "source of truth" for THIS reconciliation's purpose — catching audit
-- events that were silently lost between emission and persistence — is
-- an ingestion-ATTEMPT counter incremented once per canonical audit
-- event AuditEventConsumerPipelineService is ever invoked with,
-- BEFORE schema validation/enrichment/persistence, so it counts even
-- events that go on to fail. "Actual" is audit_events (successfully
-- persisted) + audit_events_dlq (explicitly failed, still recorded) for
-- the same period; any gap between attempted and (persisted + DLQ'd) is
-- an event that vanished with NO record at all — the actual failure mode
-- this reconciliation exists to catch (e.g. a crash mid-processing).
CREATE TABLE audit_ingestion_counters (
    tenant_id       UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    day             DATE NOT NULL,
    attempted_count BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, day)
);

SELECT enable_tenant_isolation('audit_ingestion_counters');
SELECT attach_tenant_context_guard('audit_ingestion_counters');

GRANT SELECT, INSERT, UPDATE ON audit_ingestion_counters TO ams_app;

-- Reconciliation run reports (daily) and deep-sample run reports
-- (monthly) — one table, distinguished by report_type, since both are
-- "a health check ran, here's what it found" records with the same
-- shape (counts, discrepancy, alert flag).
CREATE TABLE audit_reconciliation_reports (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    report_type       TEXT NOT NULL CHECK (report_type IN ('daily_reconciliation', 'monthly_deep_sample')),
    period_start      TIMESTAMPTZ NOT NULL,
    period_end        TIMESTAMPTZ NOT NULL,
    expected_count    BIGINT NOT NULL,
    actual_count      BIGINT NOT NULL,
    gap_count         BIGINT NOT NULL,
    gap_percentage    NUMERIC(10, 6) NOT NULL,
    tolerance_percentage NUMERIC(10, 6) NOT NULL,
    status            TEXT NOT NULL CHECK (status IN ('healthy', 'discrepancy_detected')),
    alert_triggered   BOOLEAN NOT NULL DEFAULT false,
    details           JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_reconciliation_reports_tenant_created ON audit_reconciliation_reports (tenant_id, created_at DESC);

SELECT enable_tenant_isolation('audit_reconciliation_reports');
SELECT attach_tenant_context_guard('audit_reconciliation_reports');

GRANT SELECT, INSERT ON audit_reconciliation_reports TO ams_app;
