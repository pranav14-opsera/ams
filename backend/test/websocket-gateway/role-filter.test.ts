import { test } from "node:test";
import assert from "node:assert/strict";
import { isAuthorizedForMessage } from "../../src/websocket-gateway/role-filter";

test("a message with no requiredRoles is visible to everyone", () => {
  assert.equal(isAuthorizedForMessage(undefined, []), true);
  assert.equal(isAuthorizedForMessage([], ["agent_operator"]), true);
});

test("a user holding one of the required roles is authorized", () => {
  assert.equal(isAuthorizedForMessage(["platform_admin", "finance_manager"], ["finance_manager"]), true);
});

test("a Finance Manager does not receive agent trace data (this WO's own example)", () => {
  assert.equal(isAuthorizedForMessage(["platform_admin", "agent_operator"], ["finance_manager"]), false);
});

test("an Agent Operator does not receive credit allocation changes (this WO's own example)", () => {
  assert.equal(isAuthorizedForMessage(["finance_manager"], ["agent_operator"]), false);
});

test("a multi-role user receives the union of everything any of their roles authorizes", () => {
  assert.equal(isAuthorizedForMessage(["finance_manager"], ["agent_operator", "finance_manager"]), true);
});
