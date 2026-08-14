import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionService } from "../../../src/auth/session/session.service";
import { InMemorySessionStore } from "../../../src/auth/session/in-memory-session-store.service";
import { InMemoryRefreshTokenStore } from "../../../src/auth/token/in-memory-refresh-token-store.service";
import { TenantSessionPolicyRepository } from "../../../src/auth/session/tenant-session-policy.repository";
import { InMemoryAuditService } from "../../../src/tenants/ports/in-memory/in-memory-audit.service";

// findByTenantId is the only DB access SessionService itself makes
// (to look up a tenant's session policy) — a fake pool that always
// reports "no policy row" is a faithful stand-in for a freshly
// provisioned tenant with no policy configured yet, not a shortcut
// around real behavior.
const fakePool = { query: async () => ({ rows: [] }) } as any;

function buildRig() {
  const sessionStore = new InMemorySessionStore();
  const refreshTokenStore = new InMemoryRefreshTokenStore();
  const audit = new InMemoryAuditService();
  const sessionService = new SessionService(fakePool, sessionStore, refreshTokenStore, new TenantSessionPolicyRepository(), audit);
  return { sessionService, sessionStore, refreshTokenStore, audit };
}

test("createSession stores a session with default policy timeouts and emits an audit event", async () => {
  const { sessionService, sessionStore, audit } = buildRig();
  const session = await sessionService.createSession("user-1", "tenant-a", "fingerprint-1");

  assert.ok(session.sessionId);
  assert.equal(session.idleTimeoutSeconds, 1800);
  assert.equal(session.absoluteTimeoutSeconds, 28800);
  assert.equal(session.mfaElevated, false);
  assert.ok(await sessionStore.get(session.sessionId));
  assert.ok(audit.events.some((e) => e.action === "auth.session.created"));
});

test("validateSession succeeds for a fresh session and returns its record", async () => {
  const { sessionService } = buildRig();
  const session = await sessionService.createSession("user-1", "tenant-a", "fingerprint-1");
  const validated = await sessionService.validateSession(session.sessionId);
  assert.equal(validated.sessionId, session.sessionId);
});

test("validateSession rejects an unknown session id", async () => {
  const { sessionService } = buildRig();
  await assert.rejects(() => sessionService.validateSession("never-created"));
});

test("validateSession rejects and invalidates a session past its idle timeout", async () => {
  const { sessionService, sessionStore, audit } = buildRig();
  const session = await sessionService.createSession("user-1", "tenant-a", "fingerprint-1");

  const wellPastIdle = new Date(Date.now() + (session.idleTimeoutSeconds + 60) * 1000);
  await assert.rejects(() => sessionService.validateSession(session.sessionId, wellPastIdle));

  assert.equal(await sessionStore.get(session.sessionId), null, "an idle-timed-out session must be invalidated, not just rejected");
  assert.ok(audit.events.some((e) => e.action === "auth.session.invalidated" && (e.details as any).reason === "idle_timeout"));
});

test("validateSession rejects and invalidates a session past its absolute timeout even with recent activity", async () => {
  const { sessionService, sessionStore, audit } = buildRig();
  const session = await sessionService.createSession("user-1", "tenant-a", "fingerprint-1");

  const wellPastAbsolute = new Date(Date.now() + (session.absoluteTimeoutSeconds + 60) * 1000);
  // Simulate "recent activity" directly in the store: without this, idle
  // time would ALSO have elapsed (lastActivityAt defaults to createdAt),
  // and the idle check — which runs first — would fire instead, making
  // this test indistinguishable from the idle-timeout one above. Setting
  // lastActivityAt to just before wellPastAbsolute isolates the absolute
  // check specifically.
  await sessionStore.touch(session.sessionId, new Date(wellPastAbsolute.getTime() - 10_000));

  await assert.rejects(() => sessionService.validateSession(session.sessionId, wellPastAbsolute));

  assert.equal(await sessionStore.get(session.sessionId), null);
  assert.ok(audit.events.some((e) => e.action === "auth.session.invalidated" && (e.details as any).reason === "absolute_timeout"));
});

test("validateSession touches last_activity_at only after the 60-second debounce window", async () => {
  const { sessionService, sessionStore } = buildRig();
  const session = await sessionService.createSession("user-1", "tenant-a", "fingerprint-1");

  const thirtySecondsLater = new Date(Date.now() + 30 * 1000);
  await sessionService.validateSession(session.sessionId, thirtySecondsLater);
  const afterFirstCheck = await sessionStore.get(session.sessionId);
  assert.equal(afterFirstCheck!.lastActivityAt.getTime(), session.createdAt.getTime(), "under 60s since last touch — must NOT have written a new activity timestamp");

  const ninetySecondsLater = new Date(Date.now() + 90 * 1000);
  await sessionService.validateSession(session.sessionId, ninetySecondsLater);
  const afterSecondCheck = await sessionStore.get(session.sessionId);
  assert.equal(afterSecondCheck!.lastActivityAt.getTime(), ninetySecondsLater.getTime(), "past the 60s debounce — must have touched last_activity_at");
});

test("invalidateSession removes the session AND revokes its associated refresh token", async () => {
  const { sessionService, sessionStore, refreshTokenStore } = buildRig();
  const session = await sessionService.createSession("user-1", "tenant-a", "fingerprint-1");
  await refreshTokenStore.store("refresh-token-abc", { userId: "user-1", tenantId: "tenant-a", deviceFingerprint: "fingerprint-1", roles: [], sessionId: session.sessionId }, 3600);

  await sessionService.invalidateSession(session.sessionId, "admin_force_logout");

  assert.equal(await sessionStore.get(session.sessionId), null);
  assert.equal(await refreshTokenStore.consumeAndInvalidate("refresh-token-abc"), null, "the refresh token tied to this session must be revoked too");
});

test("invalidateAllUserSessions removes every session for a user and revokes every refresh token", async () => {
  const { sessionService, sessionStore, refreshTokenStore, audit } = buildRig();
  const sessionA = await sessionService.createSession("user-1", "tenant-a", "fingerprint-1");
  const sessionB = await sessionService.createSession("user-1", "tenant-a", "fingerprint-2");
  await refreshTokenStore.store("token-a", { userId: "user-1", tenantId: "tenant-a", deviceFingerprint: "fingerprint-1", roles: [], sessionId: sessionA.sessionId }, 3600);
  await refreshTokenStore.store("token-b", { userId: "user-1", tenantId: "tenant-a", deviceFingerprint: "fingerprint-2", roles: [], sessionId: sessionB.sessionId }, 3600);

  await sessionService.invalidateAllUserSessions("user-1", "tenant-a", "scim_deprovisioned");

  assert.equal(await sessionStore.get(sessionA.sessionId), null);
  assert.equal(await sessionStore.get(sessionB.sessionId), null);
  assert.equal(await refreshTokenStore.consumeAndInvalidate("token-a"), null);
  assert.equal(await refreshTokenStore.consumeAndInvalidate("token-b"), null);
  assert.ok(audit.events.some((e) => e.action === "auth.session.all_invalidated"));
});

test("invalidateAllUserSessions does not affect another user's sessions", async () => {
  const { sessionService, sessionStore } = buildRig();
  const mine = await sessionService.createSession("user-1", "tenant-a", "fingerprint-1");
  const theirs = await sessionService.createSession("user-2", "tenant-a", "fingerprint-1");

  await sessionService.invalidateAllUserSessions("user-1", "tenant-a", "test");

  assert.equal(await sessionStore.get(mine.sessionId), null);
  assert.ok(await sessionStore.get(theirs.sessionId), "another user's session must be untouched");
});
