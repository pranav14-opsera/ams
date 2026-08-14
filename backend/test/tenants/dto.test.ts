import { test } from "node:test";
import assert from "node:assert/strict";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CreateTenantDto } from "../../src/tenants/dto/create-tenant.dto";
import { UpdateTenantSettingsDto } from "../../src/tenants/dto/update-tenant-settings.dto";

test("CreateTenantDto accepts a valid payload", async () => {
  const dto = plainToInstance(CreateTenantDto, { name: "Acme Health", slug: "acme-health", dataResidencyRegion: "us" });
  const errors = await validate(dto);
  assert.equal(errors.length, 0);
});

test("CreateTenantDto rejects a slug with uppercase/invalid characters", async () => {
  const dto = plainToInstance(CreateTenantDto, { name: "Acme", slug: "Acme_Health!", dataResidencyRegion: "us" });
  const errors = await validate(dto);
  assert.ok(errors.some((e) => e.property === "slug"));
});

test("CreateTenantDto rejects a dataResidencyRegion outside us/eu", async () => {
  const dto = plainToInstance(CreateTenantDto, { name: "Acme", slug: "acme", dataResidencyRegion: "apac" });
  const errors = await validate(dto);
  assert.ok(errors.some((e) => e.property === "dataResidencyRegion"));
});

test("CreateTenantDto rejects a missing name", async () => {
  const dto = plainToInstance(CreateTenantDto, { slug: "acme", dataResidencyRegion: "us" });
  const errors = await validate(dto);
  assert.ok(errors.some((e) => e.property === "name"));
});

test("UpdateTenantSettingsDto requires settings to be an object", async () => {
  const dto = plainToInstance(UpdateTenantSettingsDto, { settings: "not-an-object" });
  const errors = await validate(dto);
  assert.ok(errors.some((e) => e.property === "settings"));
});

test("UpdateTenantSettingsDto accepts a valid settings object", async () => {
  const dto = plainToInstance(UpdateTenantSettingsDto, { settings: { sessionTimeoutMinutes: 30 } });
  const errors = await validate(dto);
  assert.equal(errors.length, 0);
});
