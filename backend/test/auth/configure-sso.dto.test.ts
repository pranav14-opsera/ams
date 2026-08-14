import { test } from "node:test";
import assert from "node:assert/strict";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { ConfigureSsoDto } from "../../src/auth/dto/configure-sso.dto";

test("accepts a valid SAML config", async () => {
  const dto = plainToInstance(ConfigureSsoDto, {
    protocol: "saml",
    samlMetadataUrl: "https://idp.example.com/metadata",
    samlEntityId: "ams-platform",
  });
  const errors = await validate(dto);
  assert.equal(errors.length, 0);
});

test("accepts a valid OIDC config", async () => {
  const dto = plainToInstance(ConfigureSsoDto, {
    protocol: "oidc",
    oidcDiscoveryUrl: "https://idp.example.com/.well-known/openid-configuration",
    oidcClientId: "client-1",
    oidcClientSecret: "shh",
  });
  const errors = await validate(dto);
  assert.equal(errors.length, 0);
});

test("rejects an unknown protocol", async () => {
  const dto = plainToInstance(ConfigureSsoDto, { protocol: "ldap" });
  const errors = await validate(dto);
  assert.ok(errors.some((e) => e.property === "protocol"));
});

test("rejects a SAML config missing samlMetadataUrl", async () => {
  const dto = plainToInstance(ConfigureSsoDto, { protocol: "saml", samlEntityId: "ams-platform" });
  const errors = await validate(dto);
  assert.ok(errors.some((e) => e.property === "samlMetadataUrl"));
});

test("rejects an OIDC config missing oidcClientId", async () => {
  const dto = plainToInstance(ConfigureSsoDto, { protocol: "oidc", oidcDiscoveryUrl: "https://idp.example.com/.well-known/openid-configuration" });
  const errors = await validate(dto);
  assert.ok(errors.some((e) => e.property === "oidcClientId"));
});

test("does not require SAML fields when protocol is oidc, and vice versa", async () => {
  const dto = plainToInstance(ConfigureSsoDto, {
    protocol: "oidc",
    oidcDiscoveryUrl: "https://idp.example.com/.well-known/openid-configuration",
    oidcClientId: "client-1",
    oidcClientSecret: "shh",
  });
  const errors = await validate(dto);
  assert.equal(errors.length, 0, "samlMetadataUrl/samlEntityId must not be required when protocol=oidc");
});

test("rejects an out-of-range metadataRefreshIntervalHours", async () => {
  const dto = plainToInstance(ConfigureSsoDto, {
    protocol: "saml",
    samlMetadataUrl: "https://idp.example.com/metadata",
    samlEntityId: "ams-platform",
    metadataRefreshIntervalHours: 0,
  });
  const errors = await validate(dto);
  assert.ok(errors.some((e) => e.property === "metadataRefreshIntervalHours"));
});
