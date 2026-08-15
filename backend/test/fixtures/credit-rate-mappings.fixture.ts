export const FIXTURE_RATE_ACTION_TYPES = ["tool_call", "llm_completion", "embedding", "web_search", "file_processing"] as const;
export const FIXTURE_RATE_TENANT_SLUGS = ["fixture-rate-tenant-a", "fixture-rate-tenant-b", "fixture-rate-tenant-c"] as const;

export interface RateMappingFixture {
  tenantSlug: (typeof FIXTURE_RATE_TENANT_SLUGS)[number];
  actionType: (typeof FIXTURE_RATE_ACTION_TYPES)[number];
  creditsPerUnit: number;
}

export interface CachedBalanceFixture {
  tenantSlug: (typeof FIXTURE_RATE_TENANT_SLUGS)[number];
  teamKey: string;
  balance: number;
}

/** AC: "rate mappings (5 action types across 3 tenants)" — deterministic, no Math.random(). */
export function generateRateMappingFixtures(): RateMappingFixture[] {
  const fixtures: RateMappingFixture[] = [];
  FIXTURE_RATE_TENANT_SLUGS.forEach((tenantSlug, tenantIndex) => {
    FIXTURE_RATE_ACTION_TYPES.forEach((actionType, actionIndex) => {
      // A different, deterministic rate per (tenant, action) pair — tenants aren't all charged identically, actions aren't all priced the same.
      fixtures.push({ tenantSlug, actionType, creditsPerUnit: 1 + tenantIndex * 2 + actionIndex * 3 });
    });
  });
  return fixtures;
}

/** AC: "pre-seeded Redis balances" — one deterministic starting balance per tenant+team pair. */
export function generateCachedBalanceFixtures(): CachedBalanceFixture[] {
  const fixtures: CachedBalanceFixture[] = [];
  FIXTURE_RATE_TENANT_SLUGS.forEach((tenantSlug, tenantIndex) => {
    for (let teamIndex = 0; teamIndex < 5; teamIndex++) {
      fixtures.push({ tenantSlug, teamKey: `team-${teamIndex + 1}`, balance: 1000 + tenantIndex * 500 + teamIndex * 100 });
    }
  });
  return fixtures;
}
