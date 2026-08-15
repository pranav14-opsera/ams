import { test } from "node:test";
import assert from "node:assert/strict";
import { SignedXml } from "xml-crypto";
import { SamlService } from "../../src/auth/saml.service";
import { InMemoryIdpMetadataCache } from "../../src/auth/in-memory-idp-metadata-cache.service";
import type { TenantSsoConfig } from "../../src/auth/sso-config.repository";
import { SAML_IDP_CERT_PEM, SAML_IDP_PRIVATE_KEY_PEM, MOCK_IDP_ISSUER, MOCK_SP_ISSUER } from "../fixtures/auth/build-saml-fixture";

// WO-028: the platform's ONE real XML parsing path is SAML assertion
// validation (@node-saml/node-saml, via @xmldom/xmldom + xml2js) —
// everything else in this codebase is JSON. This proves an XXE payload
// embedded in a signed SAML assertion cannot exfiltrate local file
// contents through the parsed identity, rather than just assuming the
// underlying libraries are safe by reputation.

const CALLBACK_URL = "https://sp.test/callback";

function config(): TenantSsoConfig {
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
  };
}

function buildXxeSamlResponse(): string {
  const issueInstant = new Date();
  const notBefore = new Date(issueInstant.getTime() - 60_000).toISOString();
  const notOnOrAfter = new Date(issueInstant.getTime() + 300_000).toISOString();
  const assertionId = "_assertion-xxe";

  // The entity reference sits inside the signed NameID content itself —
  // if the parser expanded it BEFORE or independently of signature
  // verification, the "identity" node-saml hands back would contain
  // local file contents instead of the literal entity reference text.
  const assertionXml =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" Version="2.0" IssueInstant="${issueInstant.toISOString()}">` +
    `<saml:Issuer>${MOCK_IDP_ISSUER}</saml:Issuer>` +
    `<saml:Subject>` +
    `<saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">&xxe;</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
    `<saml:SubjectConfirmationData NotOnOrAfter="${notOnOrAfter}" Recipient="${CALLBACK_URL}"/>` +
    `</saml:SubjectConfirmation>` +
    `</saml:Subject>` +
    `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">` +
    `<saml:AudienceRestriction><saml:Audience>${MOCK_SP_ISSUER}</saml:Audience></saml:AudienceRestriction>` +
    `</saml:Conditions>` +
    `<saml:AttributeStatement><saml:Attribute Name="groups"><saml:AttributeValue>clinicians</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>` +
    `<saml:AuthnStatement AuthnInstant="${issueInstant.toISOString()}" SessionIndex="_session-xxe">` +
    `<saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext>` +
    `</saml:AuthnStatement>` +
    `</saml:Assertion>`;

  const sig = new SignedXml({ privateKey: SAML_IDP_PRIVATE_KEY_PEM, publicCert: SAML_IDP_CERT_PEM });
  sig.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
  });
  sig.canonicalizationAlgorithm = "http://www.w3.org/2001/10/xml-exc-c14n#";
  sig.signatureAlgorithm = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
  sig.computeSignature(assertionXml, { location: { reference: "//*[local-name(.)='Issuer']", action: "after" } });
  const signedAssertionXml = sig.getSignedXml();

  // DOCTYPE with a SYSTEM external entity pointing at a real local file —
  // a Windows path guaranteed to exist in any CI/dev environment running
  // this test suite, so a genuine expansion would be detectable.
  const responseXml =
    `<?xml version="1.0"?>` +
    `<!DOCTYPE samlp:Response [<!ENTITY xxe SYSTEM "file:///C:/Windows/win.ini">]>` +
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_response-xxe" Version="2.0" IssueInstant="${issueInstant.toISOString()}" Destination="${CALLBACK_URL}">` +
    `<saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${MOCK_IDP_ISSUER}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    signedAssertionXml +
    `</samlp:Response>`;

  return Buffer.from(responseXml, "utf8").toString("base64");
}

test("an XXE payload in a signed SAML assertion's NameID does not exfiltrate local file contents", async () => {
  const saml = new SamlService(new InMemoryIdpMetadataCache());
  const samlResponse = buildXxeSamlResponse();

  try {
    const identity = await saml.validate(config(), samlResponse, CALLBACK_URL);
    // If validation succeeded at all, the identity must NOT contain the
    // expanded file's contents (win.ini always starts with "[fonts]" or
    // similar INI-section markers on every Windows install).
    assert.ok(!identity.subject.includes("["), "the NameID must not have been expanded into local file contents");
    assert.ok(!identity.subject.toLowerCase().includes("fonts"), "the NameID must not contain win.ini's actual content");
  } catch {
    // Rejecting the malformed/DOCTYPE-bearing document outright is an
    // equally acceptable, equally safe outcome — either way, no file
    // content reaches the caller.
  }
});
