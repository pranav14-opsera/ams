import { test } from "node:test";
import assert from "node:assert/strict";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { UpsertGroupMappingDto } from "../../../src/auth/provisioning/dto/upsert-group-mapping.dto";

test("accepts a valid mapping", async () => {
  const dto = plainToInstance(UpsertGroupMappingDto, { idpGroup: "org-admins", platformRole: "platform_admin", priority: 10 });
  assert.equal((await validate(dto)).length, 0);
});

test("rejects an empty idpGroup", async () => {
  const dto = plainToInstance(UpsertGroupMappingDto, { idpGroup: "", platformRole: "platform_admin", priority: 10 });
  const errors = await validate(dto);
  assert.ok(errors.some((e) => e.property === "idpGroup"));
});

test("rejects a platformRole outside the five valid platform roles", async () => {
  const dto = plainToInstance(UpsertGroupMappingDto, { idpGroup: "clinicians", platformRole: "clinician", priority: 10 });
  const errors = await validate(dto);
  assert.ok(errors.some((e) => e.property === "platformRole"));
});

test("rejects a negative priority", async () => {
  const dto = plainToInstance(UpsertGroupMappingDto, { idpGroup: "clinicians", platformRole: "agent_operator", priority: -1 });
  const errors = await validate(dto);
  assert.ok(errors.some((e) => e.property === "priority"));
});
