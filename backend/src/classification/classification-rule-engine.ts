import { Injectable, Optional } from "@nestjs/common";
import { DataClassification, isAtLeastAsSensitive } from "./data-classification.enum";

export interface ClassifiablePayload {
  resourceType: string;
  /** If the caller already knows the tier (e.g. an explicit API field), it's honored as a floor, not bypassed — see evaluate(). */
  declaredClassification?: DataClassification;
  fields?: Record<string, unknown>;
}

export interface ClassificationRule {
  tier: DataClassification;
  /** Human-readable, for audit/debugging — which rule fired. */
  name: string;
  matches: (payload: ClassifiablePayload) => boolean;
}

export interface FieldOverrideConfig {
  resourceType: string;
  tier: DataClassification;
}

// Platform-default rules. Deliberately structural (resourceType / known
// field-name patterns), not content inspection — that's the PHI
// Scrubber's job (WO-017), which runs AFTER this tagger in the pipeline
// per this WO's own description. Ordered Restricted-first per the
// acceptance criteria ("fail-safe: unknown data defaults to
// CONFIDENTIAL, not PUBLIC" — evaluate() falls through to CONFIDENTIAL,
// never PUBLIC, when nothing below matches).
const RESTRICTED_RESOURCE_TYPES = new Set(["health_record", "patient_note", "clinical_data", "agent_credential", "encryption_key_material"]);
const RESTRICTED_FIELD_NAME_PATTERN = /(ssn|social_security|diagnosis|medical_record_number|patient_id|dob|date_of_birth)/i;
const CONFIDENTIAL_RESOURCE_TYPES = new Set(["credit_transaction", "rbac_policy", "abac_policy", "governance_rule", "dsr_request"]);
const INTERNAL_RESOURCE_TYPES = new Set(["agent", "agent_metrics", "agent_state_transition", "team", "user"]);
const PUBLIC_RESOURCE_TYPES = new Set(["system_status", "public_documentation"]);

function hasRestrictedFieldName(fields: Record<string, unknown> | undefined): boolean {
  if (!fields) return false;
  return Object.keys(fields).some((key) => RESTRICTED_FIELD_NAME_PATTERN.test(key));
}

export const PLATFORM_DEFAULT_RULES: ClassificationRule[] = [
  {
    tier: DataClassification.RESTRICTED,
    name: "explicit-restricted-declaration",
    matches: (p) => p.declaredClassification === DataClassification.RESTRICTED,
  },
  {
    tier: DataClassification.RESTRICTED,
    name: "restricted-resource-type",
    matches: (p) => RESTRICTED_RESOURCE_TYPES.has(p.resourceType),
  },
  {
    tier: DataClassification.RESTRICTED,
    name: "restricted-field-name-pattern",
    matches: (p) => hasRestrictedFieldName(p.fields),
  },
  {
    tier: DataClassification.CONFIDENTIAL,
    name: "explicit-confidential-declaration",
    matches: (p) => p.declaredClassification === DataClassification.CONFIDENTIAL,
  },
  {
    tier: DataClassification.CONFIDENTIAL,
    name: "confidential-resource-type",
    matches: (p) => CONFIDENTIAL_RESOURCE_TYPES.has(p.resourceType),
  },
  {
    tier: DataClassification.INTERNAL,
    name: "explicit-internal-declaration",
    matches: (p) => p.declaredClassification === DataClassification.INTERNAL,
  },
  {
    tier: DataClassification.INTERNAL,
    name: "internal-resource-type",
    matches: (p) => INTERNAL_RESOURCE_TYPES.has(p.resourceType),
  },
  {
    tier: DataClassification.PUBLIC,
    name: "explicit-public-declaration",
    matches: (p) => p.declaredClassification === DataClassification.PUBLIC,
  },
  {
    tier: DataClassification.PUBLIC,
    name: "public-resource-type",
    matches: (p) => PUBLIC_RESOURCE_TYPES.has(p.resourceType),
  },
];

export interface ClassificationResult {
  tier: DataClassification;
  matchedRule: string;
}

@Injectable()
export class ClassificationRuleEngine {
  // @Optional() so NestJS's DI container doesn't try to resolve a
  // provider for a plain array type (which isn't a valid injection
  // token) when this class is constructed via the DI container rather
  // than directly with `new` — found by actually booting the app, not
  // assumed. Tests that want custom rules still just call
  // `new ClassificationRuleEngine(customRules)` directly.
  private readonly rules: ClassificationRule[];

  constructor(@Optional() rules?: ClassificationRule[]) {
    this.rules = rules ?? PLATFORM_DEFAULT_RULES;
  }

  /**
   * Evaluates a payload against platform rules, then against any
   * tenant-specific field overrides. Rules are checked in the engine's
   * configured order (Restricted-tier rules first) — the FIRST match
   * wins, so ordering IS the specificity mechanism the acceptance
   * criteria call for.
   *
   * Tenant overrides (loaded from tenants.settings.classificationOverrides,
   * see TenantClassificationOverrides below) are applied AFTER platform
   * rules and can only raise the resulting tier, never lower it — a
   * tenant cannot use its own settings to downgrade PUBLIC's platform
   * classification of, say, agent_credential to something less
   * protected. An override attempting to lower sensitivity is silently
   * ignored (not applied), not an error — a misconfigured tenant setting
   * should never accidentally under-protect data.
   */
  evaluate(payload: ClassifiablePayload, tenantOverrides: FieldOverrideConfig[] = []): ClassificationResult {
    let result = this.evaluatePlatformRules(payload);

    const override = tenantOverrides.find((o) => o.resourceType === payload.resourceType);
    if (override && isAtLeastAsSensitive(override.tier, result.tier)) {
      result = { tier: override.tier, matchedRule: `tenant-override:${override.resourceType}` };
    }

    return result;
  }

  private evaluatePlatformRules(payload: ClassifiablePayload): ClassificationResult {
    for (const rule of this.rules) {
      if (rule.matches(payload)) {
        return { tier: rule.tier, matchedRule: rule.name };
      }
    }
    // Fail-safe default per the acceptance criteria: unknown data is
    // CONFIDENTIAL, never PUBLIC.
    return { tier: DataClassification.CONFIDENTIAL, matchedRule: "default-fallback" };
  }
}
