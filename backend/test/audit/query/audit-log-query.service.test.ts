import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { AuditLogQueryService } from "../../../src/audit/query/audit-log-query.service";
import { PermissionName } from "../../../src/rbac/rbac.constants";

function fakeRepository() {
  const calls: any[] = [];
  return {
    calls,
    findByFilters: async (filters: any) => {
      calls.push(filters);
      return { entries: [], nextCursor: null };
    },
  } as any;
}

test("a caller with AUDIT_LOGS_VIEW_ORG gets unrestricted (org-wide) access — no actor-id restriction is applied", async () => {
  const repository = fakeRepository();
  const pool = { query: async () => ({ rows: [] }) } as any;
  const service = new AuditLogQueryService(pool, repository);

  const result = await service.query(
    { tenantId: "t1", actorId: "u1", permissions: [PermissionName.AUDIT_LOGS_VIEW_ORG] },
    { startTime: "2026-01-01T00:00:00Z", endTime: "2026-01-31T23:59:59Z" } as any,
  );

  assert.equal(result.restrictedToTeamScope, false);
  assert.equal(repository.calls[0].restrictToActorIds, undefined);
});

test("a caller with ONLY AUDIT_LOGS_VIEW_TEAM is restricted to their team's member actor_ids", async () => {
  const repository = fakeRepository();
  const teamMembers = ["u1", "u2", "u3"];
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("SELECT team_id FROM team_members")) return { rows: [{ team_id: "team-A" }] };
      if (sql.includes("SELECT DISTINCT user_id")) return { rows: teamMembers.map((id) => ({ user_id: id })) };
      return { rows: [] };
    },
  } as any;
  const service = new AuditLogQueryService(pool, repository);

  const result = await service.query(
    { tenantId: "t1", actorId: "u1", permissions: [PermissionName.AUDIT_LOGS_VIEW_TEAM] },
    { startTime: "2026-01-01T00:00:00Z", endTime: "2026-01-31T23:59:59Z" } as any,
  );

  assert.equal(result.restrictedToTeamScope, true);
  assert.deepEqual(repository.calls[0].restrictToActorIds.sort(), teamMembers.sort());
});

test("a team_lead who belongs to no team at all is restricted to just their own actions (never sees the whole tenant by accident)", async () => {
  const repository = fakeRepository();
  const pool = { query: async () => ({ rows: [] }) } as any; // no team_members row for this user
  const service = new AuditLogQueryService(pool, repository);

  const result = await service.query({ tenantId: "t1", actorId: "lonely-user", permissions: [PermissionName.AUDIT_LOGS_VIEW_TEAM] }, { startTime: "2026-01-01T00:00:00Z", endTime: "2026-01-31T23:59:59Z" } as any);

  assert.equal(result.restrictedToTeamScope, true);
  assert.deepEqual(repository.calls[0].restrictToActorIds, ["lonely-user"]);
});

test("a caller with BOTH view_org and view_team (platform_admin) gets org-wide access — the broader grant wins", async () => {
  const repository = fakeRepository();
  const pool = { query: async () => ({ rows: [] }) } as any;
  const service = new AuditLogQueryService(pool, repository);

  const result = await service.query(
    { tenantId: "t1", actorId: randomUUID(), permissions: [PermissionName.AUDIT_LOGS_VIEW_ORG, PermissionName.AUDIT_LOGS_VIEW_TEAM] },
    { startTime: "2026-01-01T00:00:00Z", endTime: "2026-01-31T23:59:59Z" } as any,
  );

  assert.equal(result.restrictedToTeamScope, false);
});

test("filters from the DTO are passed straight through to the repository, alongside the resolved scope restriction", async () => {
  const repository = fakeRepository();
  const pool = { query: async () => ({ rows: [] }) } as any;
  const service = new AuditLogQueryService(pool, repository);

  await service.query(
    { tenantId: "t1", actorId: "u1", permissions: [PermissionName.AUDIT_LOGS_VIEW_ORG] },
    { startTime: "2026-01-01T00:00:00Z", endTime: "2026-01-31T23:59:59Z", action: "user.login", limit: 25, cursor: "abc" } as any,
  );

  assert.equal(repository.calls[0].action, "user.login");
});
