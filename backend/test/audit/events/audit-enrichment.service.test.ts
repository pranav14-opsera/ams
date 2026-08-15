import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AuditEnrichmentService, TenantValidationError } from "../../../src/audit/events/audit-enrichment.service";
import { ActorType, type CanonicalAuditEvent } from "../../../src/audit/events/canonical-audit-event";

function fakeEvent(overrides: Partial<CanonicalAuditEvent> = {}): CanonicalAuditEvent {
  return {
    event_id: randomUUID(),
    actor_id: randomUUID(),
    actor_type: ActorType.USER,
    tenant_id: randomUUID(),
    action: "user.login",
    resource_type: "session",
    resource_id: null,
    data_classification: "internal",
    ip_address: "203.0.113.7",
    change_details: {},
    correlation_id: null,
    occurred_at: new Date().toISOString(),
    ...overrides,
  };
}

function fakeTenantRepository(exists = true) {
  return { findById: async () => (exists ? { id: "t1", settings: null } : null) } as any;
}

test("enrich() throws TenantValidationError for an unknown tenant_id", async () => {
  const pool = { query: async () => ({ rows: [], rowCount: 0 }) } as any;
  const service = new AuditEnrichmentService(pool, fakeTenantRepository(false));
  await assert.rejects(() => service.enrich(fakeEvent()), TenantValidationError);
});

test("enrich() sets actor_resolved:true when a matching user row is found", async () => {
  const pool = { query: async () => ({ rows: [{}], rowCount: 1 }) } as any;
  const service = new AuditEnrichmentService(pool, fakeTenantRepository(true));
  const result = await service.enrich(fakeEvent());
  assert.equal(result.actor_resolved, true);
});

test("enrich() sets actor_resolved:false when no matching user row is found, but still succeeds (doesn't throw)", async () => {
  const pool = { query: async () => ({ rows: [], rowCount: 0 }) } as any;
  const service = new AuditEnrichmentService(pool, fakeTenantRepository(true));
  const result = await service.enrich(fakeEvent());
  assert.equal(result.actor_resolved, false);
});

test("enrich() never attempts actor resolution for non-user actor types", async () => {
  let queried = false;
  const pool = {
    query: async () => {
      queried = true;
      return { rows: [], rowCount: 0 };
    },
  } as any;
  const service = new AuditEnrichmentService(pool, fakeTenantRepository(true));
  const result = await service.enrich(fakeEvent({ actor_type: ActorType.SYSTEM, actor_id: null }));
  assert.equal(result.actor_resolved, false);
  assert.equal(queried, false, "a system/service_account/api_key actor has no users row to look up");
});

test("enrich() passes through a valid data_classification unchanged", async () => {
  const pool = { query: async () => ({ rows: [{}], rowCount: 1 }) } as any;
  const service = new AuditEnrichmentService(pool, fakeTenantRepository(true));
  const result = await service.enrich(fakeEvent({ data_classification: "confidential" }));
  assert.equal(result.data_classification, "confidential");
});

test("enrich() defaults a missing data_classification to 'restricted' (defense-in-depth: strictest tier, not loosest)", async () => {
  const pool = { query: async () => ({ rows: [{}], rowCount: 1 }) } as any;
  const service = new AuditEnrichmentService(pool, fakeTenantRepository(true));
  const result = await service.enrich(fakeEvent({ data_classification: null }));
  assert.equal(result.data_classification, "restricted");
});

test("enrich() defaults an unrecognized data_classification value to 'restricted' too", async () => {
  const pool = { query: async () => ({ rows: [{}], rowCount: 1 }) } as any;
  const service = new AuditEnrichmentService(pool, fakeTenantRepository(true));
  const result = await service.enrich(fakeEvent({ data_classification: "top-secret" as any }));
  assert.equal(result.data_classification, "restricted");
});

test("enrich() adds a server-side enriched_at timestamp", async () => {
  const pool = { query: async () => ({ rows: [{}], rowCount: 1 }) } as any;
  const service = new AuditEnrichmentService(pool, fakeTenantRepository(true));
  const before = Date.now();
  const result = await service.enrich(fakeEvent());
  const after = Date.now();
  const enrichedAtMs = new Date(result.enriched_at).getTime();
  assert.ok(enrichedAtMs >= before && enrichedAtMs <= after);
});
