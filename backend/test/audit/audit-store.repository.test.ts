import { test } from "node:test";
import assert from "node:assert/strict";
import { AuditStoreRepository } from "../../src/audit/audit-store.repository";

function fakeRow(overrides: Partial<{ id: string; record_hash: string; occurred_at: Date }> = {}) {
  return { id: "11111111-1111-1111-1111-111111111111", record_hash: "a".repeat(64), occurred_at: new Date(), ...overrides };
}

function fakeEvent() {
  return { tenantId: "t1", actorId: null, action: "test.action", resourceType: "test_resource", resourceId: "22222222-2222-2222-2222-222222222222", details: {} };
}

test("insertAuditEvent returns id/recordHash/occurredAt from the INSERT ... RETURNING row", async () => {
  const calls: unknown[] = [];
  const pool = {
    query: async (_sql: string, params: unknown[]) => {
      calls.push(params);
      return { rows: [fakeRow()] };
    },
  } as any;
  const repository = new AuditStoreRepository(pool);

  const result = await repository.insertAuditEvent(fakeEvent());
  assert.equal(result.id, "11111111-1111-1111-1111-111111111111");
  assert.equal(result.recordHash, "a".repeat(64));
  assert.equal(calls.length, 1);
});

test("insertAuditEvent retries on a retryable Postgres error (serialization_failure), succeeding on a later attempt", async () => {
  let attempt = 0;
  const pool = {
    query: async () => {
      attempt++;
      if (attempt < 3) {
        const err: any = new Error("could not serialize access due to concurrent update");
        err.code = "40001";
        throw err;
      }
      return { rows: [fakeRow()] };
    },
  } as any;
  const repository = new AuditStoreRepository(pool);

  const result = await repository.insertAuditEvent(fakeEvent());
  assert.equal(attempt, 3);
  assert.equal(result.id, "11111111-1111-1111-1111-111111111111");
});

test("insertAuditEvent retries on deadlock_detected too", async () => {
  let attempt = 0;
  const pool = {
    query: async () => {
      attempt++;
      if (attempt < 2) {
        const err: any = new Error("deadlock detected");
        err.code = "40P01";
        throw err;
      }
      return { rows: [fakeRow()] };
    },
  } as any;
  const repository = new AuditStoreRepository(pool);

  await repository.insertAuditEvent(fakeEvent());
  assert.equal(attempt, 2);
});

test("insertAuditEvent gives up after 3 attempts and rethrows the last retryable error", async () => {
  let attempt = 0;
  const pool = {
    query: async () => {
      attempt++;
      const err: any = new Error("could not serialize access due to concurrent update");
      err.code = "40001";
      throw err;
    },
  } as any;
  const repository = new AuditStoreRepository(pool);

  await assert.rejects(() => repository.insertAuditEvent(fakeEvent()), /could not serialize access/);
  assert.equal(attempt, 3, "must give up after exactly 3 attempts, not retry forever");
});

test("insertAuditEvent does NOT retry a non-retryable error (e.g. a genuine constraint violation) — fails immediately", async () => {
  let attempt = 0;
  const pool = {
    query: async () => {
      attempt++;
      const err: any = new Error("null value in column violates not-null constraint");
      err.code = "23502";
      throw err;
    },
  } as any;
  const repository = new AuditStoreRepository(pool);

  await assert.rejects(() => repository.insertAuditEvent(fakeEvent()), /not-null constraint/);
  assert.equal(attempt, 1, "a non-retryable error must fail on the first attempt, not retry uselessly");
});

test("getLastHash returns null when the tenant has no audit events yet (genesis)", async () => {
  const pool = { query: async () => ({ rows: [] }) } as any;
  const repository = new AuditStoreRepository(pool);
  assert.equal(await repository.getLastHash("t1"), null);
});

test("getLastHash returns the record_hash of the most recent row", async () => {
  const pool = { query: async () => ({ rows: [{ record_hash: "b".repeat(64) }] }) } as any;
  const repository = new AuditStoreRepository(pool);
  assert.equal(await repository.getLastHash("t1"), "b".repeat(64));
});

test("verifyChain maps the SQL function's result row to the typed return shape", async () => {
  const pool = {
    query: async () => ({
      rows: [{ valid: false, first_broken_id: "33333333-3333-3333-3333-333333333333", first_broken_occurred_at: new Date("2026-01-01T00:00:00Z"), detail: "tampered" }],
    }),
  } as any;
  const repository = new AuditStoreRepository(pool);

  const result = await repository.verifyChain("t1", new Date("2026-01-01"), new Date("2026-01-02"));
  assert.equal(result.valid, false);
  assert.equal(result.firstBrokenId, "33333333-3333-3333-3333-333333333333");
  assert.equal(result.detail, "tampered");
});
