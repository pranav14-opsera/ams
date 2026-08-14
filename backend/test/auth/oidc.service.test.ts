import { test } from "node:test";
import assert from "node:assert/strict";
import { OidcService } from "../../src/auth/oidc.service";
import { EncryptionService } from "../../src/encryption/encryption.service";
import { InMemoryKmsService } from "../../src/tenants/ports/in-memory/in-memory-kms.service";
import type { TenantSsoConfig } from "../../src/auth/sso-config.repository";
import { startMockOidcProvider, type MockOidcProvider } from "../fixtures/auth/mock-oidc-provider";

const CALLBACK_URL = "https://sp.test/oidc/callback";
const TENANT_ID = "tenant-a";

async function buildConfig(kms: InMemoryKmsService, encryptionService: EncryptionService, provider: MockOidcProvider): Promise<TenantSsoConfig> {
  await kms.createTenantKey(TENANT_ID, "us");
  const encryptedSecret = await encryptionService.encrypt(TENANT_ID, Buffer.from(provider.clientSecret, "utf8"));
  return {
    id: "config-1",
    tenantId: TENANT_ID,
    protocol: "oidc",
    samlMetadataUrl: null,
    samlEntityId: null,
    samlCertPem: null,
    oidcDiscoveryUrl: `${provider.issuerUrl}/.well-known/openid-configuration`,
    oidcClientId: provider.clientId,
    oidcClientSecret: encryptedSecret,
    metadataRefreshIntervalHours: 24,
    metadataLastFetchedAt: null,
    version: 1,
  };
}

test("validates a real OIDC authorization code exchange and extracts identity + groups", async () => {
  const provider = await startMockOidcProvider();
  try {
    const kms = new InMemoryKmsService();
    const encryptionService = new EncryptionService(null as any, kms, null as any, null as any);
    const config = await buildConfig(kms, encryptionService, provider);
    provider.issueIdToken({ sub: "clinician@example.com", email: "clinician@example.com", groups: ["clinicians", "admins"] });

    const oidc = new OidcService(encryptionService);
    const identity = await oidc.validate(config, "any-code", CALLBACK_URL);

    assert.equal(identity.subject, "clinician@example.com");
    assert.equal(identity.email, "clinician@example.com");
    assert.deepEqual(identity.groups, ["clinicians", "admins"]);
  } finally {
    await provider.close();
  }
});

test("rejects an expired id_token", async () => {
  const provider = await startMockOidcProvider();
  try {
    const kms = new InMemoryKmsService();
    const encryptionService = new EncryptionService(null as any, kms, null as any, null as any);
    const config = await buildConfig(kms, encryptionService, provider);
    provider.issueIdToken({}, { expiresInSeconds: -10 });

    const oidc = new OidcService(encryptionService);
    await assert.rejects(() => oidc.validate(config, "any-code", CALLBACK_URL));
  } finally {
    await provider.close();
  }
});

test("rejects an id_token issued for a different audience (wrong client_id)", async () => {
  const provider = await startMockOidcProvider();
  try {
    const kms = new InMemoryKmsService();
    const encryptionService = new EncryptionService(null as any, kms, null as any, null as any);
    const config = await buildConfig(kms, encryptionService, provider);
    provider.issueIdToken({ aud: "some-other-client-id" });

    const oidc = new OidcService(encryptionService);
    await assert.rejects(() => oidc.validate(config, "any-code", CALLBACK_URL));
  } finally {
    await provider.close();
  }
});

test("extracts groups from a comma-separated 'roles' claim when 'groups' is absent", async () => {
  const provider = await startMockOidcProvider();
  try {
    const kms = new InMemoryKmsService();
    const encryptionService = new EncryptionService(null as any, kms, null as any, null as any);
    const config = await buildConfig(kms, encryptionService, provider);
    provider.issueIdToken({ groups: undefined, roles: "clinicians, admins" });

    const oidc = new OidcService(encryptionService);
    const identity = await oidc.validate(config, "any-code", CALLBACK_URL);
    assert.deepEqual(identity.groups, ["clinicians", "admins"]);
  } finally {
    await provider.close();
  }
});

test("returns no groups when neither groups nor roles claims are present", async () => {
  const provider = await startMockOidcProvider();
  try {
    const kms = new InMemoryKmsService();
    const encryptionService = new EncryptionService(null as any, kms, null as any, null as any);
    const config = await buildConfig(kms, encryptionService, provider);
    provider.issueIdToken({ groups: undefined });

    const oidc = new OidcService(encryptionService);
    const identity = await oidc.validate(config, "any-code", CALLBACK_URL);
    assert.deepEqual(identity.groups, []);
  } finally {
    await provider.close();
  }
});

test("rejects when the IdP is unreachable (bad discovery URL)", async () => {
  const kms = new InMemoryKmsService();
  const encryptionService = new EncryptionService(null as any, kms, null as any, null as any);
  await kms.createTenantKey(TENANT_ID, "us");
  const badConfig: TenantSsoConfig = {
    id: "config-1",
    tenantId: TENANT_ID,
    protocol: "oidc",
    samlMetadataUrl: null,
    samlEntityId: null,
    samlCertPem: null,
    oidcDiscoveryUrl: "http://127.0.0.1:1/.well-known/openid-configuration", // nothing listening on port 1
    oidcClientId: "x",
    oidcClientSecret: await encryptionService.encrypt(TENANT_ID, Buffer.from("secret")),
    metadataRefreshIntervalHours: 24,
    metadataLastFetchedAt: null,
    version: 1,
  };

  const oidc = new OidcService(encryptionService);
  await assert.rejects(() => oidc.validate(badConfig, "any-code", CALLBACK_URL));
});
