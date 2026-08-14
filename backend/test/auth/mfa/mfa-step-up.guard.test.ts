import { test } from "node:test";
import assert from "node:assert/strict";
import { Reflector } from "@nestjs/core";
import type { ExecutionContext } from "@nestjs/common";
import { MfaStepUpGuard } from "../../../src/auth/mfa/mfa-step-up.guard";
import { InMemorySessionStore } from "../../../src/auth/session/in-memory-session-store.service";
import { DataClassification } from "../../../src/classification/data-classification.enum";
import { TenantMfaPolicyRepository } from "../../../src/auth/mfa/tenant-mfa-policy.repository";

const TENANT_ID = "tenant-a";

function fakePoolReturningPolicy(policyRow: Record<string, unknown> | null) {
  return { query: async () => ({ rows: policyRow ? [policyRow] : [] }) } as any;
}

function fakeContext(_tier: DataClassification | undefined, req: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: () => ({}),
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function buildGuard(reflectorTier: DataClassification | undefined, policyRow: Record<string, unknown> | null, sessionStore: InMemorySessionStore) {
  const reflector = { get: () => reflectorTier } as unknown as Reflector;
  return new MfaStepUpGuard(reflector, fakePoolReturningPolicy(policyRow), sessionStore, new TenantMfaPolicyRepository());
}

test("allows the request when the route declares no classification at all", async () => {
  const guard = buildGuard(undefined, null, new InMemorySessionStore());
  const context = fakeContext(undefined, { tenantId: TENANT_ID, sessionId: "s1" });
  assert.equal(await guard.canActivate(context), true);
});

test("RESTRICTED: denies with MFA_REQUIRED when the session has no MFA elevation at all", async () => {
  const sessionStore = new InMemorySessionStore();
  await sessionStore.create({
    sessionId: "s1", userId: "u1", tenantId: TENANT_ID, deviceFingerprint: "fp", createdAt: new Date(), lastActivityAt: new Date(),
    idleTimeoutSeconds: 1800, absoluteTimeoutSeconds: 28800, mfaElevated: false, mfaElevatedAt: null,
  });
  const guard = buildGuard(DataClassification.RESTRICTED, null, sessionStore);
  const context = fakeContext(DataClassification.RESTRICTED, { tenantId: TENANT_ID, sessionId: "s1" });

  await assert.rejects(
    () => guard.canActivate(context),
    (err: any) => {
      assert.equal(err.getResponse().error, "MFA_REQUIRED");
      assert.equal(err.getResponse().classification, "restricted");
      return true;
    },
  );
});

test("RESTRICTED: allows access when MFA was elevated recently (within the policy's elevation window)", async () => {
  const sessionStore = new InMemorySessionStore();
  await sessionStore.create({
    sessionId: "s1", userId: "u1", tenantId: TENANT_ID, deviceFingerprint: "fp", createdAt: new Date(), lastActivityAt: new Date(),
    idleTimeoutSeconds: 1800, absoluteTimeoutSeconds: 28800, mfaElevated: true, mfaElevatedAt: new Date(),
  });
  const guard = buildGuard(DataClassification.RESTRICTED, { tenant_id: TENANT_ID, restricted_elevation_minutes: 60, require_mfa_for_internal: false, require_mfa_for_public: false }, sessionStore);
  const context = fakeContext(DataClassification.RESTRICTED, { tenantId: TENANT_ID, sessionId: "s1" });
  assert.equal(await guard.canActivate(context), true);
});

test("RESTRICTED: denies once the elevation window has elapsed, even though mfaElevated is still true", async () => {
  const sessionStore = new InMemorySessionStore();
  const longAgo = new Date(Date.now() - 90 * 60 * 1000); // 90 minutes ago
  await sessionStore.create({
    sessionId: "s1", userId: "u1", tenantId: TENANT_ID, deviceFingerprint: "fp", createdAt: new Date(), lastActivityAt: new Date(),
    idleTimeoutSeconds: 1800, absoluteTimeoutSeconds: 28800, mfaElevated: true, mfaElevatedAt: longAgo,
  });
  const guard = buildGuard(DataClassification.RESTRICTED, { tenant_id: TENANT_ID, restricted_elevation_minutes: 60, require_mfa_for_internal: false, require_mfa_for_public: false }, sessionStore);
  const context = fakeContext(DataClassification.RESTRICTED, { tenantId: TENANT_ID, sessionId: "s1" });

  await assert.rejects(() => guard.canActivate(context));
});

test("CONFIDENTIAL: allows access once elevated, with no duration limit (session-lifetime)", async () => {
  const sessionStore = new InMemorySessionStore();
  const longAgo = new Date(Date.now() - 5 * 60 * 60 * 1000); // 5 hours ago — would fail Restricted's 60-min window
  await sessionStore.create({
    sessionId: "s1", userId: "u1", tenantId: TENANT_ID, deviceFingerprint: "fp", createdAt: new Date(), lastActivityAt: new Date(),
    idleTimeoutSeconds: 1800, absoluteTimeoutSeconds: 28800, mfaElevated: true, mfaElevatedAt: longAgo,
  });
  const guard = buildGuard(DataClassification.CONFIDENTIAL, null, sessionStore);
  const context = fakeContext(DataClassification.CONFIDENTIAL, { tenantId: TENANT_ID, sessionId: "s1" });
  assert.equal(await guard.canActivate(context), true);
});

test("INTERNAL: allowed by default (tenant policy does not require MFA for Internal)", async () => {
  const guard = buildGuard(DataClassification.INTERNAL, null, new InMemorySessionStore());
  const context = fakeContext(DataClassification.INTERNAL, { tenantId: TENANT_ID, sessionId: "s1" });
  assert.equal(await guard.canActivate(context), true);
});

test("INTERNAL: denied when the tenant has opted into requiring MFA for Internal and the session isn't elevated", async () => {
  const guard = buildGuard(DataClassification.INTERNAL, { tenant_id: TENANT_ID, restricted_elevation_minutes: 60, require_mfa_for_internal: true, require_mfa_for_public: false }, new InMemorySessionStore());
  const context = fakeContext(DataClassification.INTERNAL, { tenantId: TENANT_ID, sessionId: "s1" });
  await assert.rejects(() => guard.canActivate(context));
});

test("PUBLIC: allowed by default", async () => {
  const guard = buildGuard(DataClassification.PUBLIC, null, new InMemorySessionStore());
  const context = fakeContext(DataClassification.PUBLIC, { tenantId: TENANT_ID, sessionId: "s1" });
  assert.equal(await guard.canActivate(context), true);
});

test("denies when the request has no sessionId at all for a gated tier", async () => {
  const guard = buildGuard(DataClassification.RESTRICTED, null, new InMemorySessionStore());
  const context = fakeContext(DataClassification.RESTRICTED, { tenantId: TENANT_ID, sessionId: undefined });
  await assert.rejects(() => guard.canActivate(context));
});
