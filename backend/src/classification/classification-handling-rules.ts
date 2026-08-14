import { DataClassification } from "./data-classification.enum";

export type EncryptionTarget = "platform_kms" | "byok";
export type AuditLevel = "standard" | "elevated" | "full_detail_required_approval";

export interface ClassificationHandlingRule {
  tier: DataClassification;
  encryptionTarget: EncryptionTarget;
  /** e.g. "mfa_step_up", "human_approval_for_agent_access" — enforced elsewhere; this is the declarative requirement list. */
  accessControlRequirements: readonly string[];
  auditLevel: AuditLevel;
  retentionDays: number;
}

function rule(input: ClassificationHandlingRule): Readonly<ClassificationHandlingRule> {
  // Object.freeze is shallow — freezing just the top-level object would
  // still let accessControlRequirements (a nested array) be mutated in
  // place. Freeze both levels so "immutable platform policy" is a real
  // guarantee, not just a TypeScript-level one.
  Object.freeze(input.accessControlRequirements);
  return Object.freeze(input);
}

// Per-tier handling, exactly as WO-016's acceptance criteria specify.
export const CLASSIFICATION_HANDLING_RULES: Readonly<Record<DataClassification, ClassificationHandlingRule>> = Object.freeze({
  [DataClassification.PUBLIC]: rule({
    tier: DataClassification.PUBLIC,
    encryptionTarget: "platform_kms",
    accessControlRequirements: [],
    auditLevel: "standard",
    retentionDays: 90,
  }),
  [DataClassification.INTERNAL]: rule({
    tier: DataClassification.INTERNAL,
    encryptionTarget: "platform_kms",
    accessControlRequirements: [],
    auditLevel: "standard",
    retentionDays: 365,
  }),
  [DataClassification.CONFIDENTIAL]: rule({
    tier: DataClassification.CONFIDENTIAL,
    encryptionTarget: "platform_kms",
    accessControlRequirements: ["mfa_step_up"],
    auditLevel: "elevated",
    retentionDays: 365 * 3,
  }),
  [DataClassification.RESTRICTED]: rule({
    tier: DataClassification.RESTRICTED,
    encryptionTarget: "byok", // WO-015's EncryptionService/KmsServicePort
    accessControlRequirements: ["minimum_necessary_authorization", "human_approval_for_agent_access"],
    auditLevel: "full_detail_required_approval",
    retentionDays: 365 * 7, // matches audit_events' own 7-year retention policy (migration 005)
  }),
});

export function handlingRuleFor(tier: DataClassification): ClassificationHandlingRule {
  return CLASSIFICATION_HANDLING_RULES[tier];
}
