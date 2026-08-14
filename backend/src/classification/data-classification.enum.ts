// The four tiers named in WO-016's acceptance criteria. Values match
// audit_events.data_classification's CHECK constraint exactly (migration
// 017 renamed that column's 4th tier from 'phi' to 'restricted' to match
// this enum, rather than leaving a silent app-vs-schema naming mismatch).
export enum DataClassification {
  PUBLIC = "public",
  INTERNAL = "internal",
  CONFIDENTIAL = "confidential",
  RESTRICTED = "restricted",
}

// Ascending sensitivity order — used both for "check Restricted first"
// rule evaluation and for enforcing that a tenant override may only ever
// raise a payload's tier, never lower it.
const TIER_ORDER: readonly DataClassification[] = [
  DataClassification.PUBLIC,
  DataClassification.INTERNAL,
  DataClassification.CONFIDENTIAL,
  DataClassification.RESTRICTED,
];

export function tierRank(tier: DataClassification): number {
  return TIER_ORDER.indexOf(tier);
}

export function isAtLeastAsSensitive(candidate: DataClassification, floor: DataClassification): boolean {
  return tierRank(candidate) >= tierRank(floor);
}
