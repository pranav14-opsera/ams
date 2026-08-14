import type { PhiPatternSet } from "./phi-patterns";

/**
 * Loads additional tenant-specific PHI field-name patterns from
 * tenants.settings.phiFieldNamePatterns (JSONB array of regex source
 * strings — regexes can't be stored directly in JSON). Same
 * fail-degraded philosophy as the classification override loader
 * (WO-016): a malformed or invalid-regex entry is dropped silently, not
 * thrown — one bad tenant setting must never take down scrubbing for
 * that tenant entirely, since the platform defaults still apply
 * regardless. Value-pattern overrides aren't supported: value shapes
 * (SSN, MRN, DOB formats) are platform-wide facts about what PHI looks
 * like, not something a tenant should be redefining, whereas field NAMES
 * are legitimately tenant/schema-specific (a tenant's own custom field
 * called "insured_party_id" might carry PHI the platform can't know
 * about in advance).
 */
export function loadTenantPhiFieldNamePatterns(settings: Record<string, unknown> | null | undefined): RegExp[] {
  const raw = settings?.["phiFieldNamePatterns"];
  if (!Array.isArray(raw)) return [];

  const patterns: RegExp[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.length === 0) continue;
    try {
      patterns.push(new RegExp(entry, "i"));
    } catch {
      // Invalid regex source — skip this one entry, not the whole tenant.
      continue;
    }
  }
  return patterns;
}

export function mergeWithTenantOverrides(base: PhiPatternSet, tenantSettings: Record<string, unknown> | null | undefined): PhiPatternSet {
  const tenantFieldPatterns = loadTenantPhiFieldNamePatterns(tenantSettings);
  if (tenantFieldPatterns.length === 0) return base;
  return {
    fieldNamePatterns: [...base.fieldNamePatterns, ...tenantFieldPatterns],
    valuePatterns: base.valuePatterns,
  };
}
