export const FIXTURE_BUDGET_TENANT_SLUGS = ["fixture-budget-tenant-alpha", "fixture-budget-tenant-beta", "fixture-budget-tenant-gamma"] as const;

export interface OrganizationPoolFixture {
  tenantSlug: (typeof FIXTURE_BUDGET_TENANT_SLUGS)[number];
  totalCredits: number;
}

export interface TeamBudgetFixture {
  tenantSlug: (typeof FIXTURE_BUDGET_TENANT_SLUGS)[number];
  teamKey: string;
  allocatedCredits: number;
  alertThreshold75: boolean;
  alertThreshold90: boolean;
}

/** AC: "organization credit pools (3 tenants with varying pool sizes)." Deterministic — no Math.random(). */
export function generateOrganizationPoolFixtures(): OrganizationPoolFixture[] {
  return [
    { tenantSlug: "fixture-budget-tenant-alpha", totalCredits: 10_000 },
    { tenantSlug: "fixture-budget-tenant-beta", totalCredits: 25_000 },
    { tenantSlug: "fixture-budget-tenant-gamma", totalCredits: 5_000 },
  ];
}

/** AC: "pre-existing team budgets." Two teams per tenant, allocations sized to fit within each tenant's own pool fixture above. */
export function generateTeamBudgetFixtures(): TeamBudgetFixture[] {
  return [
    { tenantSlug: "fixture-budget-tenant-alpha", teamKey: "team-1", allocatedCredits: 6000, alertThreshold75: true, alertThreshold90: true },
    { tenantSlug: "fixture-budget-tenant-alpha", teamKey: "team-2", allocatedCredits: 3000, alertThreshold75: true, alertThreshold90: false },
    { tenantSlug: "fixture-budget-tenant-beta", teamKey: "team-1", allocatedCredits: 15_000, alertThreshold75: true, alertThreshold90: true },
    { tenantSlug: "fixture-budget-tenant-beta", teamKey: "team-2", allocatedCredits: 8000, alertThreshold75: false, alertThreshold90: true },
    { tenantSlug: "fixture-budget-tenant-gamma", teamKey: "team-1", allocatedCredits: 4000, alertThreshold75: true, alertThreshold90: true },
  ];
}
