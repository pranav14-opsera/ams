import { SignedXml } from "xml-crypto";
import { SAML_IDP_CERT_PEM, SAML_IDP_PRIVATE_KEY_PEM } from "./saml-idp-keypair";

export { SAML_IDP_CERT_PEM, SAML_IDP_PRIVATE_KEY_PEM };
export const SAML_IDP_CERT_BASE64 = SAML_IDP_CERT_PEM.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");

export const MOCK_SP_ISSUER = "ams-platform";
export const MOCK_IDP_ISSUER = "https://mock-idp.test";

export function buildSamlMetadataXml(): string {
  return `<?xml version="1.0"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${MOCK_IDP_ISSUER}">
  <IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <KeyDescriptor use="signing">
      <ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
        <ds:X509Data><ds:X509Certificate>${SAML_IDP_CERT_BASE64}</ds:X509Certificate></ds:X509Data>
      </ds:KeyInfo>
    </KeyDescriptor>
  </IDPSSODescriptor>
</EntityDescriptor>`;
}

export interface SamlAssertionOptions {
  nameId?: string;
  email?: string;
  groups?: string[];
  assertionId?: string;
  issuedSecondsAgo?: number; // for building an already-expired assertion
  validitySeconds?: number;
  tamperAfterSigning?: boolean;
}

/** Builds and signs a real SAML 2.0 Response containing one Assertion, returned base64-encoded exactly as a browser would POST it. */
export function buildSignedSamlResponse(options: SamlAssertionOptions = {}): string {
  const {
    nameId = "user-1@example.com",
    email = nameId,
    groups = ["clinicians"],
    assertionId = "_assertion-" + Math.random().toString(36).slice(2),
    issuedSecondsAgo = 0,
    validitySeconds = 300,
    tamperAfterSigning = false,
  } = options;

  const issueInstant = new Date(Date.now() - issuedSecondsAgo * 1000);
  const notBefore = new Date(issueInstant.getTime() - 60_000).toISOString();
  const notOnOrAfter = new Date(issueInstant.getTime() + validitySeconds * 1000).toISOString();
  const sessionIndex = "_session-" + Math.random().toString(36).slice(2);

  const attributeValues = groups.map((g) => `<saml:AttributeValue>${g}</saml:AttributeValue>`).join("");

  const assertionXml =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" Version="2.0" IssueInstant="${issueInstant.toISOString()}">` +
    `<saml:Issuer>${MOCK_IDP_ISSUER}</saml:Issuer>` +
    `<saml:Subject>` +
    `<saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${nameId}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
    `<saml:SubjectConfirmationData NotOnOrAfter="${notOnOrAfter}" Recipient="https://sp.test/callback"/>` +
    `</saml:SubjectConfirmation>` +
    `</saml:Subject>` +
    `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">` +
    `<saml:AudienceRestriction><saml:Audience>${MOCK_SP_ISSUER}</saml:Audience></saml:AudienceRestriction>` +
    `</saml:Conditions>` +
    `<saml:AttributeStatement>` +
    `<saml:Attribute Name="groups">${attributeValues}</saml:Attribute>` +
    `<saml:Attribute Name="email"><saml:AttributeValue>${email}</saml:AttributeValue></saml:Attribute>` +
    `</saml:AttributeStatement>` +
    `<saml:AuthnStatement AuthnInstant="${issueInstant.toISOString()}" SessionIndex="${sessionIndex}">` +
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
  sig.computeSignature(assertionXml, {
    location: { reference: "//*[local-name(.)='Issuer']", action: "after" },
  });
  let signedAssertionXml = sig.getSignedXml();

  if (tamperAfterSigning) {
    // Flip the NameID after signing — proves the signature actually
    // covers (and therefore detects tampering of) the assertion content,
    // not just its presence.
    signedAssertionXml = signedAssertionXml.replace(nameId, "attacker@evil.test");
  }

  const responseXml =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_response-${Math.random().toString(36).slice(2)}" Version="2.0" IssueInstant="${issueInstant.toISOString()}" Destination="https://sp.test/callback">` +
    `<saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${MOCK_IDP_ISSUER}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    signedAssertionXml +
    `</samlp:Response>`;

  return Buffer.from(responseXml, "utf8").toString("base64");
}
