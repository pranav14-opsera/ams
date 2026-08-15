import { test } from "node:test";
import assert from "node:assert/strict";
import { AuditReconciliationService } from "../../../src/audit/reconciliation/audit-reconciliation.service";

function fakePool(counts: { persisted: number; dlq: number }) {
  return {
    connect: async () => ({
      query: async (sql: string) => {
        if (sql.startsWith("BEGIN") || sql.startsWith("COMMIT") || sql.startsWith("ROLLBACK") || sql.includes("set_config")) return {};
        if (sql.includes("FROM audit_events WHERE")) return { rows: [{ c: counts.persisted }] };
        if (sql.includes("FROM audit_events_dlq")) return { rows: [{ c: counts.dlq }] };
        return { rows: [] };
      },
      release: () => undefined,
    }),
  } as any;
}

function fakeIngestionCounter(expected: number) {
  return { sumForRange: async () => expected } as any;
}

function fakeReportRepository() {
  const created: any[] = [];
  return { created, create: async (input: any) => { created.push(input); return { id: "report-1", ...input }; } } as any;
}

function fakeProducer() {
  return { publish: async () => undefined } as any;
}

function fakePipeline() {
  const processed: any[] = [];
  return { processed, process: async (_client: unknown, event: unknown) => { processed.push(event); return { accepted: true, eventId: "x", auditRowId: "y", deadLettered: false }; } } as any;
}

function fakeManifestRepository() {
  return { findOverlappingUnpurged: async () => [] } as any;
}

function fakeColdStorage() {
  return { readArchive: async function* () {} } as any;
}

test("WO-049: rows already tiered to cold storage for the reconciliation period count as 'actual' too — a tiered partition is never flagged as a gap", async () => {
  const pool = fakePool({ persisted: 95, dlq: 0 });
  const manifestRepository = { findOverlappingUnpurged: async () => [{ storageKey: "archive-1" }] } as any;
  const coldStorage = {
    readArchive: async function* () {
      for (let i = 0; i < 5; i++) yield { tenant_id: "t1", occurred_at: "2026-01-01T12:00:00.000Z" };
      yield { tenant_id: "other-tenant", occurred_at: "2026-01-01T12:00:00.000Z" }; // a different tenant's row in the same shared archive must NOT be counted
    },
  } as any;
  const service = new AuditReconciliationService(pool, fakeIngestionCounter(100), fakeReportRepository(), fakeProducer(), fakePipeline(), manifestRepository, coldStorage);

  const report = await service.runDailyReconciliation("t1", new Date("2026-01-01"), new Date("2026-01-02"));
  assert.equal(report.status, "healthy");
  assert.equal(report.actualCount, 100);
  assert.equal(report.gapCount, 0);
  assert.equal((report.details as any).tieredCount, 5);
});

test("reports healthy when expected and actual counts match exactly", async () => {
  const pool = fakePool({ persisted: 100, dlq: 0 });
  const service = new AuditReconciliationService(pool, fakeIngestionCounter(100), fakeReportRepository(), fakeProducer(), fakePipeline(), fakeManifestRepository(), fakeColdStorage());

  const report = await service.runDailyReconciliation("t1", new Date("2026-01-01"), new Date("2026-01-02"));
  assert.equal(report.status, "healthy");
  assert.equal(report.alertTriggered, false);
  assert.equal(report.gapCount, 0);
  assert.equal(report.gapPercentage, 0);
});

test("counts persisted + DLQ'd events together as 'actual' — a DLQ'd event is not a gap", async () => {
  const pool = fakePool({ persisted: 95, dlq: 5 });
  const service = new AuditReconciliationService(pool, fakeIngestionCounter(100), fakeReportRepository(), fakeProducer(), fakePipeline(), fakeManifestRepository(), fakeColdStorage());

  const report = await service.runDailyReconciliation("t1", new Date("2026-01-01"), new Date("2026-01-02"));
  assert.equal(report.status, "healthy");
  assert.equal(report.actualCount, 100);
  assert.equal(report.gapCount, 0);
});

test("flags a discrepancy and triggers an alert when the gap exceeds the tolerance", async () => {
  const pool = fakePool({ persisted: 900, dlq: 0 });
  const reportRepository = fakeReportRepository();
  const pipeline = fakePipeline();
  const service = new AuditReconciliationService(pool, fakeIngestionCounter(1000), reportRepository, fakeProducer(), pipeline, fakeManifestRepository(), fakeColdStorage());

  const report = await service.runDailyReconciliation("t1", new Date("2026-01-01"), new Date("2026-01-02"), 0.1);
  assert.equal(report.status, "discrepancy_detected");
  assert.equal(report.alertTriggered, true);
  assert.equal(report.gapCount, 100);
  assert.equal(report.gapPercentage, 10);
  assert.equal(pipeline.processed.length, 1, "an alert must itself be recorded as an audit event");
  assert.equal(pipeline.processed[0].action, "reconciliation.gap_detected");
});

test("a gap within the configured tolerance does not trigger an alert", async () => {
  const pool = fakePool({ persisted: 999, dlq: 0 });
  const pipeline = fakePipeline();
  const service = new AuditReconciliationService(pool, fakeIngestionCounter(1000), fakeReportRepository(), fakeProducer(), pipeline, fakeManifestRepository(), fakeColdStorage());

  // 0.1% gap with a 0.5% tolerance — must NOT alert.
  const report = await service.runDailyReconciliation("t1", new Date("2026-01-01"), new Date("2026-01-02"), 0.5);
  assert.equal(report.status, "healthy");
  assert.equal(report.alertTriggered, false);
  assert.equal(pipeline.processed.length, 0, "no alert audit event when within tolerance");
});

test("an expected count of zero is trivially healthy (no division by zero)", async () => {
  const pool = fakePool({ persisted: 0, dlq: 0 });
  const service = new AuditReconciliationService(pool, fakeIngestionCounter(0), fakeReportRepository(), fakeProducer(), fakePipeline(), fakeManifestRepository(), fakeColdStorage());

  const report = await service.runDailyReconciliation("t1", new Date("2026-01-01"), new Date("2026-01-02"));
  assert.equal(report.status, "healthy");
  assert.equal(report.gapPercentage, 0);
});

test("actual count exceeding expected (e.g. a late-arriving ingestion count update) never produces a negative gap", async () => {
  const pool = fakePool({ persisted: 110, dlq: 0 });
  const service = new AuditReconciliationService(pool, fakeIngestionCounter(100), fakeReportRepository(), fakeProducer(), fakePipeline(), fakeManifestRepository(), fakeColdStorage());

  const report = await service.runDailyReconciliation("t1", new Date("2026-01-01"), new Date("2026-01-02"));
  assert.equal(report.gapCount, 0);
  assert.equal(report.status, "healthy");
});
