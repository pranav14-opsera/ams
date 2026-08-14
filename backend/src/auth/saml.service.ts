import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { SAML, ValidateInResponseTo, type Profile } from "@node-saml/node-saml";
import { IDP_METADATA_CACHE, type IdpMetadataCachePort } from "./idp-metadata-cache.port";
import type { TenantSsoConfig } from "./sso-config.repository";

const ASSERTION_REPLAY_WINDOW_SECONDS = 5 * 60; // must exceed any realistic clock-skew + network delay between IdP and SP
const GROUP_ATTRIBUTE_NAMES = ["groups", "Groups", "memberOf", "http://schemas.xmlsoap.org/claims/Group"];

export interface SsoIdentity {
  subject: string; // SAML NameID / OIDC sub
  email: string | null;
  groups: string[];
}

@Injectable()
export class SamlService {
  constructor(@Inject(IDP_METADATA_CACHE) private readonly cache: IdpMetadataCachePort) {}

  /**
   * Validates a base64-encoded SAMLResponse against the tenant's cached
   * IdP certificate, rejecting expired/tampered/replayed assertions. Uses
   * ValidateInResponseTo.never because this simplified flow doesn't
   * persist outstanding AuthnRequest IDs to correlate against (that
   * would need its own request-tracking store) — replay protection here
   * instead comes from tracking each assertion's own ID, which is a
   * genuine, independent defense against the specific attack ("replay
   * the exact same assertion later") this WO's acceptance criteria call
   * out, even without full InResponseTo correlation.
   */
  async validate(config: TenantSsoConfig, samlResponse: string, callbackUrl: string): Promise<SsoIdentity> {
    if (!config.samlCertPem) {
      throw new UnauthorizedException("SSO validation failed.");
    }

    const saml = new SAML({
      idpCert: config.samlCertPem,
      issuer: config.samlEntityId ?? "ams-platform",
      callbackUrl,
      wantAssertionsSigned: true,
      // node-saml defaults wantAuthnResponseSigned to true — found via
      // testing that this rejects the (extremely common, and what this
      // service produces/expects) shape where only the Assertion itself
      // is signed, not the enclosing top-level <Response> element too.
      // wantAssertionsSigned above is what actually enforces a real
      // signature check here; without this override, a validly-signed
      // assertion-only response fails with a misleading
      // "Invalid document signature" that has nothing to do with the
      // assertion's own (valid) signature.
      wantAuthnResponseSigned: false,
      validateInResponseTo: ValidateInResponseTo.never,
    });

    let profile: Profile | null;
    try {
      const result = await saml.validatePostResponseAsync({ SAMLResponse: samlResponse });
      profile = result.profile;
    } catch {
      // Never leak *why* validation failed (expired vs. tampered vs.
      // wrong issuer) to the caller — same generic-401 requirement as
      // the rest of this WO's acceptance criteria, applied to SAML too.
      throw new UnauthorizedException("SSO validation failed.");
    }

    if (!profile || !profile.nameID) {
      throw new UnauthorizedException("SSO validation failed.");
    }

    const assertionId = profile.ID ?? profile.sessionIndex ?? profile.nameID;
    const isReplay = await this.cache.checkAndRecordAssertionId(assertionId, ASSERTION_REPLAY_WINDOW_SECONDS);
    if (isReplay) {
      throw new UnauthorizedException("SSO validation failed.");
    }

    return {
      subject: profile.nameID,
      email: (profile.email as string | undefined) ?? (profile.mail as string | undefined) ?? null,
      groups: this.extractGroups(profile),
    };
  }

  private extractGroups(profile: Profile): string[] {
    for (const attributeName of GROUP_ATTRIBUTE_NAMES) {
      const raw = profile[attributeName];
      if (raw === undefined) continue;
      if (Array.isArray(raw)) return raw.map(String);
      if (typeof raw === "string") return raw.split(",").map((g) => g.trim()).filter(Boolean);
    }
    return [];
  }
}
