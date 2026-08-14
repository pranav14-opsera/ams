import { test } from "node:test";
import assert from "node:assert/strict";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { UpdateSessionPolicyDto } from "../../../src/auth/session/dto/update-session-policy.dto";

test("accepts values within range", async () => {
  const dto = plainToInstance(UpdateSessionPolicyDto, { idleTimeoutSeconds: 1800, absoluteTimeoutSeconds: 28800 });
  assert.equal((await validate(dto)).length, 0);
});

test("rejects an idle timeout below 300 seconds (5 minutes)", async () => {
  const dto = plainToInstance(UpdateSessionPolicyDto, { idleTimeoutSeconds: 100, absoluteTimeoutSeconds: 28800 });
  const errors = await validate(dto);
  assert.ok(errors.some((e) => e.property === "idleTimeoutSeconds"));
});

test("rejects an idle timeout above 3600 seconds (60 minutes)", async () => {
  const dto = plainToInstance(UpdateSessionPolicyDto, { idleTimeoutSeconds: 7200, absoluteTimeoutSeconds: 28800 });
  const errors = await validate(dto);
  assert.ok(errors.some((e) => e.property === "idleTimeoutSeconds"));
});

test("rejects an absolute timeout below 3600 seconds (1 hour)", async () => {
  const dto = plainToInstance(UpdateSessionPolicyDto, { idleTimeoutSeconds: 1800, absoluteTimeoutSeconds: 1000 });
  const errors = await validate(dto);
  assert.ok(errors.some((e) => e.property === "absoluteTimeoutSeconds"));
});

test("rejects an absolute timeout above 86400 seconds (24 hours)", async () => {
  const dto = plainToInstance(UpdateSessionPolicyDto, { idleTimeoutSeconds: 1800, absoluteTimeoutSeconds: 100000 });
  const errors = await validate(dto);
  assert.ok(errors.some((e) => e.property === "absoluteTimeoutSeconds"));
});
