import { test } from "node:test";
import assert from "node:assert/strict";
import { ForbiddenException } from "@nestjs/common";
import type { ArgumentsHost } from "@nestjs/common";
import { RbacForbiddenExceptionFilter } from "../../src/rbac/rbac-forbidden-exception.filter";

function fakeResponse() {
  const res: any = { statusCode: 0, body: undefined, status(code: number) { this.statusCode = code; return this; }, json(body: unknown) { this.body = body; return this; } };
  return res;
}

function fakeHost(res: ReturnType<typeof fakeResponse>): ArgumentsHost {
  return { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
}

function fakeMatrixCache(grantingRoles: string[]) {
  return { getGrantingRoles: async () => grantingRoles } as any;
}

test("enriches an RbacGuard-shaped denial with granting_roles", async () => {
  const filter = new RbacForbiddenExceptionFilter(fakeMatrixCache(["platform_admin", "finance_manager"]));
  const res = fakeResponse();
  const exception = new ForbiddenException({ error: "forbidden", message: "Permission x required.", required_permission: "credit_management:allocation:manage", request_id: "req-1" });

  await filter.catch(exception, fakeHost(res));

  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body.granting_roles, ["platform_admin", "finance_manager"]);
  assert.equal(res.body.required_permission, "credit_management:allocation:manage");
  assert.equal(res.body.request_id, "req-1");
});

test("passes through a differently-shaped ForbiddenException unchanged (e.g. MfaStepUpGuard's MFA_REQUIRED)", async () => {
  const filter = new RbacForbiddenExceptionFilter(fakeMatrixCache(["should-not-appear"]));
  const res = fakeResponse();
  const exception = new ForbiddenException({ error: "MFA_REQUIRED", message: "MFA verification is required.", classification: "restricted", stepUpUrl: "/api/v1/auth/mfa/verify" });

  await filter.catch(exception, fakeHost(res));

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "MFA_REQUIRED");
  assert.equal(res.body.granting_roles, undefined, "must not be enriched — this isn't RbacGuard's denial shape");
});

test("passes through a plain-string ForbiddenException message unchanged", async () => {
  const filter = new RbacForbiddenExceptionFilter(fakeMatrixCache([]));
  const res = fakeResponse();
  const exception = new ForbiddenException("Cannot manage encryption keys for another tenant.");

  await filter.catch(exception, fakeHost(res));

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.message, "Cannot manage encryption keys for another tenant.");
});
