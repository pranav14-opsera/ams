import { Injectable, ServiceUnavailableException } from "@nestjs/common";

// Extracts the signing certificate from a real SAML metadata XML
// document. Deliberately a targeted regex rather than a full XML parse:
// this WO only ever needs one field (the signing X509Certificate) out of
// the whole metadata document, and a full DOM parse plus namespace-aware
// XPath querying (what node-saml itself uses internally for the
// documents it actually validates) would be a lot of machinery for
// extracting one base64 blob out of a well-known, narrowly-shaped tag.
// Picks the certificate under a KeyDescriptor whose use="signing" (or no
// use attribute at all, per the SAML metadata spec's default) — an
// encryption-only certificate is never a valid signing cert regardless.
const SIGNING_KEY_DESCRIPTOR_PATTERN = /<(?:\w+:)?KeyDescriptor(?:\s+use=["'](signing)["'])?[^>]*>[\s\S]*?<(?:\w+:)?X509Certificate>([\s\S]*?)<\/(?:\w+:)?X509Certificate>/g;

export function extractSigningCertFromMetadata(metadataXml: string): string | null {
  let match: RegExpExecArray | null;
  let fallback: string | null = null;
  SIGNING_KEY_DESCRIPTOR_PATTERN.lastIndex = 0;
  while ((match = SIGNING_KEY_DESCRIPTOR_PATTERN.exec(metadataXml)) !== null) {
    const [, use, certBase64] = match;
    const cert = certBase64.replace(/\s+/g, "");
    if (use === "signing") return cert;
    if (fallback === null) fallback = cert; // no explicit use= attribute — spec-default acceptable
  }
  return fallback;
}

@Injectable()
export class IdpMetadataService {
  /** Real network fetch — genuinely exercised in this WO's integration test against a local mock IdP metadata endpoint. */
  async fetchSamlSigningCert(metadataUrl: string): Promise<string> {
    let response: Response;
    try {
      response = await fetch(metadataUrl);
    } catch {
      throw new ServiceUnavailableException("Could not reach the identity provider's metadata endpoint.");
    }
    if (!response.ok) {
      throw new ServiceUnavailableException("Could not reach the identity provider's metadata endpoint.");
    }
    const xml = await response.text();
    const cert = extractSigningCertFromMetadata(xml);
    if (!cert) {
      throw new ServiceUnavailableException("Identity provider metadata did not contain a usable signing certificate.");
    }
    return cert;
  }
}
