import type { CreditEntryType } from "../../src/credits/credit-transaction.types";

export const FIXTURE_TENANT_SLUGS = ["fixture-tenant-alpha", "fixture-tenant-beta", "fixture-tenant-gamma"] as const;
export const FIXTURE_TEAM_KEYS = ["team-1", "team-2", "team-3", "team-4", "team-5"] as const;
export const FIXTURE_ACTION_TYPES = ["topup", "usage", "refund", "adjustment"] as const;

export interface CreditTransactionFixture {
  tenantSlug: (typeof FIXTURE_TENANT_SLUGS)[number];
  teamKey: (typeof FIXTURE_TEAM_KEYS)[number];
  entryType: CreditEntryType;
  amount: number;
  actionType: (typeof FIXTURE_ACTION_TYPES)[number];
  description: string;
  daysAgo: number;
}

/**
 * AC: "at least 1000 credit transactions across 3 tenants and 5 teams."
 * Deterministic (no Math.random) so the fixture is reproducible across
 * runs and CI — a simple modular pattern varies entry type, amount, and
 * action type per record instead of a fixed repeating value, without
 * needing real randomness.
 */
export function generateCreditTransactionFixtures(count: number = 1200): CreditTransactionFixture[] {
  const fixtures: CreditTransactionFixture[] = [];

  for (let i = 0; i < count; i++) {
    const tenantSlug = FIXTURE_TENANT_SLUGS[i % FIXTURE_TENANT_SLUGS.length];
    const teamKey = FIXTURE_TEAM_KEYS[Math.floor(i / FIXTURE_TENANT_SLUGS.length) % FIXTURE_TEAM_KEYS.length];
    const actionType = FIXTURE_ACTION_TYPES[i % FIXTURE_ACTION_TYPES.length];
    // topup/refund are credits (money coming in); usage/adjustment lean debit — adjustment alternates to exercise both directions.
    const entryType: CreditEntryType = actionType === "topup" || actionType === "refund" ? "credit" : actionType === "usage" ? "debit" : i % 2 === 0 ? "credit" : "debit";
    const amount = 5 + ((i * 37) % 495); // deterministic spread across 5-500

    fixtures.push({
      tenantSlug,
      teamKey,
      entryType,
      amount,
      actionType,
      description: `${actionType} #${i} for ${teamKey}`,
      daysAgo: i % 90, // spread across a 90-day window
    });
  }

  return fixtures;
}
