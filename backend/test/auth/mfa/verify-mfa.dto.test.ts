import { test } from "node:test";
import assert from "node:assert/strict";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { VerifyMfaDto } from "../../../src/auth/mfa/dto/verify-mfa.dto";

test("accepts a 6-digit TOTP code", async () => {
  const dto = plainToInstance(VerifyMfaDto, { code: "123456" });
  assert.equal((await validate(dto)).length, 0);
});

test("accepts a 10-character backup code", async () => {
  const dto = plainToInstance(VerifyMfaDto, { code: "ABCD234567" });
  assert.equal((await validate(dto)).length, 0);
});

test("rejects an empty code", async () => {
  const dto = plainToInstance(VerifyMfaDto, { code: "" });
  const errors = await validate(dto);
  assert.ok(errors.some((e) => e.property === "code"));
});

test("rejects a code shorter than 6 characters", async () => {
  const dto = plainToInstance(VerifyMfaDto, { code: "123" });
  const errors = await validate(dto);
  assert.ok(errors.some((e) => e.property === "code"));
});
