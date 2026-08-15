import { test } from "node:test";
import assert from "node:assert/strict";
import { ChannelPermissionsService } from "../../../src/websocket-gateway/subscription/channel-permissions.service";

test("a channel with no requiredPermissions rule is open to any authenticated user", () => {
  const service = new ChannelPermissionsService();
  assert.equal(service.checkPermission("agent-health", []), true);
});

test("a channel requiring a specific permission rejects a user lacking it", () => {
  const service = new ChannelPermissionsService();
  assert.equal(service.checkPermission("phi-access", ["agent_management:agent:trigger"]), false);
});

test("a channel requiring a specific permission accepts a user holding it exactly", () => {
  const service = new ChannelPermissionsService();
  assert.equal(service.checkPermission("phi-access", ["audit_access:phi_monitoring:view"]), true);
});

test("a feature-area wildcard permission (e.g. 'audit_access:*') grants any channel under that area", () => {
  const service = new ChannelPermissionsService();
  assert.equal(service.checkPermission("phi-access", ["audit_access:*"]), true);
});

test("an unrelated wildcard does not grant an unrelated channel", () => {
  const service = new ChannelPermissionsService();
  assert.equal(service.checkPermission("phi-access", ["credit_management:*"]), false);
});

test("custom rule sets override the defaults entirely", () => {
  const service = new ChannelPermissionsService([{ channel: "custom-channel", requiredPermissions: ["custom:permission"] }]);
  assert.equal(service.checkPermission("custom-channel", []), false);
  assert.equal(service.checkPermission("custom-channel", ["custom:permission"]), true);
  assert.equal(service.checkPermission("agent-health", []), true, "a channel absent from a custom rule set has no restriction registered, so it's open");
});

test("getRule returns the registered rule for a channel, or undefined", () => {
  const service = new ChannelPermissionsService();
  assert.equal(service.getRule("phi-access")?.requiredPermissions?.[0], "audit_access:phi_monitoring:view");
  assert.equal(service.getRule("nonexistent-channel"), undefined);
});
