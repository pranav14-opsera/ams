import { test } from "node:test";
import assert from "node:assert/strict";
import { SamlService } from "../../src/auth/saml.service";
import { InMemoryIdpMetadataCache } from "../../src/auth/in-memory-idp-metadata-cache.service";
import type { TenantSsoConfig } from "../../src/auth/sso-config.repository";
import { buildSignedSamlResponse, SAML_IDP_CERT_PEM } from "../fixtures/auth/build-saml-fixture";

const CALLBACK_URL = "https://sp.test/callback";

function config(overrides: Partial<TenantSsoConfig> = {}): TenantSsoConfig {
  return {
    id: "config-1",
    tenantId: "tenant-a",
    protocol: "saml",
    samlMetadataUrl: "https://mock-idp.test/metadata",
    samlEntityId: "ams-platform",
    samlCertPem: SAML_IDP_CERT_PEM,
    oidcDiscoveryUrl: null,
    oidcClientId: null,
    oidcClientSecret: null,
    metadataRefreshIntervalHours: 24,
    metadataLastFetchedAt: null,
    version: 1,
    ...overrides,
  };
}

test("validates a real, correctly-signed SAML assertion and extracts identity + groups", async () => {
  const saml = new SamlService(new InMemoryIdpMetadataCache());
  const samlResponse = buildSignedSamlResponse({ nameId: "clinician@example.com", groups: ["clinicians", "admins"] });

  const identity = await saml.validate(config(), samlResponse, CALLBACK_URL);

  assert.equal(identity.subject, "clinician@example.com");
  assert.equal(identity.email, "clinician@example.com");
  assert.deepEqual(identity.groups, ["clinicians", "admins"]);
});

test("rejects an expired assertion", async () => {
  const saml = new SamlService(new InMemoryIdpMetadataCache());
  const samlResponse = buildSignedSamlResponse({ issuedSecondsAgo: 600, validitySeconds: 300 }); // NotOnOrAfter is in the past

  await assert.rejects(() => saml.validate(config(), samlResponse, CALLBACK_URL));
});

test("rejects a tampered assertion (signature no longer matches the modified content)", async () => {
  const saml = new SamlService(new InMemoryIdpMetadataCache());
  const samlResponse = buildSignedSamlResponse({ tamperAfterSigning: true });

  await assert.rejects(() => saml.validate(config(), samlResponse, CALLBACK_URL));
});

test("rejects an assertion signed by a DIFFERENT key than the tenant's configured cert", async () => {
  const saml = new SamlService(new InMemoryIdpMetadataCache());
  const samlResponse = buildSignedSamlResponse();

  // A cert that does not match the private key that actually signed this
  // assertion — simulates a tenant's cached cert being stale/wrong.
  const wrongCertPem = SAML_IDP_CERT_PEM.replace(/[A-Za-z0-9]/, (c) => (c === "A" ? "B" : "A"));

  await assert.rejects(() => saml.validate(config({ samlCertPem: wrongCertPem }), samlResponse, CALLBACK_URL));
});

test("rejects a replayed assertion — the exact same signed response used twice", async () => {
  const cache = new InMemoryIdpMetadataCache();
  const saml = new SamlService(cache);
  const samlResponse = buildSignedSamlResponse();

  const first = await saml.validate(config(), samlResponse, CALLBACK_URL);
  assert.ok(first.subject);

  await assert.rejects(() => saml.validate(config(), samlResponse, CALLBACK_URL));
});

test("rejects a response with no configured signing cert (fail closed, not fail open)", async () => {
  const saml = new SamlService(new InMemoryIdpMetadataCache());
  const samlResponse = buildSignedSamlResponse();

  await assert.rejects(() => saml.validate(config({ samlCertPem: null }), samlResponse, CALLBACK_URL));
});
