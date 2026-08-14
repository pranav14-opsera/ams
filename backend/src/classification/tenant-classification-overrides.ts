import { DataClassification } from "./data-classification.enum";
import type { FieldOverrideConfig } from "./classification-rule-engine";

const VALID_TIERS = new Set<string>(Object.values(DataClassification));

/**
 * Parses tenants.settings.classificationOverrides (JSONB) into validated
 * FieldOverrideConfig entries. Malformed entries (missing/unknown
 * resourceType or tier) are dropped, not thrown — a single bad entry in a
 * tenant's settings blob should degrade to "that one override doesn't
 * apply", never take down classification for the whole tenant.
 *
 * The "can only raise sensitivity, never lower it" rule is enforced at
 * evaluation time in ClassificationRuleEngine.evaluate() (it needs the
 * platform-computed tier to compare against, which isn't known yet at
 * load time) — this loader's job is just safe parsing/shaping.
 */
export function loadTenantClassificationOverrides(settings: Record<string, unknown> | null | undefined): FieldOverrideConfig[] {
  const raw = settings?.["classificationOverrides"];
  if (!Array.isArray(raw)) return [];

  const overrides: FieldOverrideConfig[] = [];
  for (const entry of raw) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as Record<string, unknown>).resourceType === "string" &&
      typeof (entry as Record<string, unknown>).tier === "string" &&
      VALID_TIERS.has((entry as Record<string, unknown>).tier as string)
    ) {
      overrides.push({
        resourceType: (entry as Record<string, unknown>).resourceType as string,
        tier: (entry as Record<string, unknown>).tier as DataClassification,
      });
    }
  }
  return overrides;
}
