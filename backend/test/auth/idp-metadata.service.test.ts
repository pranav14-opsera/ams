import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { extractSigningCertFromMetadata, IdpMetadataService } from "../../src/auth/idp-metadata.service";
import { buildSamlMetadataXml, SAML_IDP_CERT_BASE64 } from "../fixtures/auth/build-saml-fixture";

test("extracts the signing certificate from real SAML metadata XML", () => {
  const cert = extractSigningCertFromMetadata(buildSamlMetadataXml());
  assert.equal(cert, SAML_IDP_CERT_BASE64);
});

test("prefers a KeyDescriptor explicitly marked use=\"signing\" over an unmarked one", () => {
  const xml = `<EntityDescriptor>
    <IDPSSODescriptor>
      <KeyDescriptor use="encryption"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>WRONG_ENC_CERT</ds:X509Certificate></ds:X509Data></ds:KeyInfo></KeyDescriptor>
      <KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>RIGHT_SIGNING_CERT</ds:X509Certificate></ds:X509Data></ds:KeyInfo></KeyDescriptor>
    </IDPSSODescriptor>
  </EntityDescriptor>`;
  assert.equal(extractSigningCertFromMetadata(xml), "RIGHT_SIGNING_CERT");
});

test("returns null when no certificate is present", () => {
  assert.equal(extractSigningCertFromMetadata("<EntityDescriptor></EntityDescriptor>"), null);
});

test("fetches and extracts a signing cert from a real local metadata endpoint", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/xml" });
    res.end(buildSamlMetadataXml());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  try {
    const service = new IdpMetadataService();
    const cert = await service.fetchSamlSigningCert(`http://127.0.0.1:${port}/metadata`);
    assert.equal(cert, SAML_IDP_CERT_BASE64);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("throws a ServiceUnavailableException when the metadata endpoint is unreachable", async () => {
  const service = new IdpMetadataService();
  await assert.rejects(() => service.fetchSamlSigningCert("http://127.0.0.1:1/metadata"));
});

test("throws when the metadata document has no usable certificate", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/xml" });
    res.end("<EntityDescriptor></EntityDescriptor>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  try {
    const service = new IdpMetadataService();
    await assert.rejects(() => service.fetchSamlSigningCert(`http://127.0.0.1:${port}/metadata`));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
