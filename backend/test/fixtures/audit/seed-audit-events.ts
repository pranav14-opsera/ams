import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { AuditStoreRepository } from "../../../src/audit/audit-store.repository";
import type { DataClassification } from "../../../src/classification/data-classification.enum";

const ACTIONS = [
  "user.login",
  "user.logout",
  "agent.created",
  "agent.paused",
  "agent.resumed",
  "credit.transaction",
  "governance.rule.updated",
  "admin.settings.changed",
  "data.accessed",
  "scim.user.provisioned",
];

const CLASSIFICATIONS: DataClassification[] = ["public", "internal", "confidential", "restricted"] as DataClassification[];

/**
 * WO-045 AC: "Mock data fixtures with at least 1,000 audit events across
 * 3 tenants and 3 monthly partitions are generated and committed for use
 * by downstream stories." Real, hash-chained rows (via AuditStoreRepository,
 * not hand-crafted SQL that would need to replicate the trigger's own
 * digest logic) — genesis-to-tip per tenant, genuinely spread across 3
 * consecutive monthly partitions computed relative to "now" (rather than
 * a hardcoded calendar month) so this always lands inside whatever
 * partition window actually exists (migration 005/038 create partitions
 * forward from whenever they were applied, not from a fixed epoch).
 *
 * Caller owns tenant provisioning/cleanup — this only inserts audit rows
 * for tenant IDs it's given.
 */
export async function seedAuditEventFixtures(pool: Pool, tenantIds: string[], totalEvents = 1000): Promise<{ insertedCount: number; monthsUsed: string[] }> {
  const repository = new AuditStoreRepository(pool);

  // Anchored strictly AFTER "now" (not e.g. day 10 of the current
  // calendar month, which can already be in the past relative to
  // whenever this actually runs) — a real bug found via testing: each
  // tenant already has its OWN "tenant.provisioned" audit_events row
  // (written by TenantProvisioningSaga at real insert time, occurred_at
  // defaulting to now()) before this fixture ever runs. If the fixture's
  // own timeline started in the past, that pre-existing row would land
  // chronologically IN THE MIDDLE of the fixture's synthetic timeline,
  // and since the hash-chain trigger links each insert to "whichever row
  // has the latest occurred_at at INSERT time" (not by chronological
  // rank after the fact), that out-of-order pre-existing row broke the
  // chain the same way as inserting fixture rows out of order would.
  // Starting 1 minute in the future guarantees every fixture row is
  // chronologically after anything already in that tenant's chain.
  const start = new Date(Date.now() + 60_000);
  const months = [0, 1, 2].map((offset) => {
    const d = new Date(start);
    d.setUTCMonth(d.getUTCMonth() + offset);
    return d;
  });
  const monthsUsed = months.map((m) => `${m.getUTCFullYear()}_${String(m.getUTCMonth() + 1).padStart(2, "0")}`);

  const perTenant = Math.ceil(totalEvents / tenantIds.length);
  // The hash chain trigger picks "the row with the latest occurred_at so
  // far" as the previous link — a real constraint of a chain keyed by
  // event time, matching how real audit events are always inserted in
  // roughly the order they happen. Events MUST be inserted in
  // monotonically increasing occurred_at order per tenant, or the trigger
  // links a row to the wrong predecessor (found via testing: an earlier
  // version of this fixture round-robinned across 3 months per-index,
  // e.g. month0, month1, month2, month0, ... — producing occurred_at
  // values that jump backward relative to insertion order and breaking
  // the chain). Spreading `perTenant` events evenly across the full span
  // from `start` to 15 days into the last month keeps occurred_at
  // strictly increasing across insertion order while still landing in
  // all 3 months, and never crosses into a 4th partition.
  const spanMs = months[months.length - 1].getTime() + 15 * 24 * 60 * 60 * 1000 - start.getTime();
  const stepMs = Math.max(1, Math.floor(spanMs / perTenant));

  let insertedCount = 0;

  for (const tenantId of tenantIds) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenantId]);

      for (let i = 0; i < perTenant; i++) {
        const occurredAt = new Date(start.getTime() + i * stepMs);
        await repository.insertAuditEvent(
          {
            tenantId,
            actorId: null,
            action: ACTIONS[i % ACTIONS.length],
            resourceType: "fixture_resource",
            resourceId: randomUUID(),
            details: { seed_index: i, fixture: true },
            dataClassification: CLASSIFICATIONS[i % CLASSIFICATIONS.length],
          },
          client,
          occurredAt,
        );
        insertedCount++;
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  return { insertedCount, monthsUsed };
}
