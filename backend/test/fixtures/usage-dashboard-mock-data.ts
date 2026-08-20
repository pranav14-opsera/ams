// WO-074: mock usage-dashboard fixtures — 3 tenants, 10+ agents each, 30
// days of consumption history, plus the edge-case scenarios the WO's own
// AC calls out by name (zero consumption, near-cap, over-cap).
//
// Shaped as plain data (not DB rows) so both the unit tests (fed straight
// into a FakeRepository) and the integration test (inserted as real
// credit_transactions rows) can reuse the exact same fixture.

export interface MockAgentFixture {
  name: string;
  framework: "langchain" | "crewai" | "autogen" | "generic_rest";
  lifecycleStatus: "active" | "paused" | "retired";
  /** Credits consumed per day, for each of the last 30 days — index 0 is 30 days ago, index 29 is today. */
  dailyConsumption: number[];
}

export interface MockTenantFixture {
  slug: string;
  name: string;
  /** Total credits ever allocated (the "credit" side of the ledger) — must exceed the sum of all agents' consumption for a healthy tenant. */
  totalAllocated: number;
  agents: MockAgentFixture[];
}

const THIRTY_ZEROS = Array.from({ length: 30 }, () => 0);
const STEADY_10 = Array.from({ length: 30 }, () => 10);
const STEADY_25 = Array.from({ length: 30 }, () => 25);
const RAMPING = Array.from({ length: 30 }, (_, i) => Math.round(5 + i * 1.5));

/**
 * Tenant 1: healthy — steady consumption well under its allocation.
 * Includes the "zero consumption" edge case (Idle Agent) and an agent
 * registered but never appearing in any transaction at all (Never Used
 * Agent — proves the LEFT JOIN FROM agents, not FROM the aggregate,
 * still surfaces it).
 */
const HEALTHY_TENANT: MockTenantFixture = {
  slug: "wo074-fixture-healthy",
  name: "WO-074 Fixture — Healthy Org",
  totalAllocated: 50_000,
  agents: [
    { name: "Claims Processor", framework: "langchain", lifecycleStatus: "active", dailyConsumption: STEADY_25 },
    { name: "Invoice Reconciler", framework: "crewai", lifecycleStatus: "active", dailyConsumption: STEADY_10 },
    { name: "Support Triage Bot", framework: "autogen", lifecycleStatus: "active", dailyConsumption: RAMPING },
    { name: "Onboarding Assistant", framework: "generic_rest", lifecycleStatus: "active", dailyConsumption: STEADY_10 },
    { name: "Fraud Scanner", framework: "langchain", lifecycleStatus: "active", dailyConsumption: STEADY_25 },
    { name: "Contract Summarizer", framework: "crewai", lifecycleStatus: "active", dailyConsumption: STEADY_10 },
    { name: "Ticket Router", framework: "autogen", lifecycleStatus: "active", dailyConsumption: STEADY_10 },
    { name: "Compliance Auditor", framework: "generic_rest", lifecycleStatus: "paused", dailyConsumption: STEADY_10 },
    { name: "Idle Agent", framework: "langchain", lifecycleStatus: "active", dailyConsumption: THIRTY_ZEROS }, // edge case: zero consumption
    { name: "Retired Legacy Bot", framework: "crewai", lifecycleStatus: "retired", dailyConsumption: THIRTY_ZEROS },
    { name: "Never Used Agent", framework: "autogen", lifecycleStatus: "active", dailyConsumption: THIRTY_ZEROS }, // edge case: never appears in any transaction
  ],
};

/** Tenant 2: near-cap — consumption is approaching its allocation (edge case). */
const NEAR_CAP_TENANT: MockTenantFixture = {
  slug: "wo074-fixture-near-cap",
  name: "WO-074 Fixture — Near-Cap Org",
  totalAllocated: 3_000,
  agents: [
    { name: "Batch Ingest Worker", framework: "langchain", lifecycleStatus: "active", dailyConsumption: STEADY_25 },
    { name: "Nightly Reconciler", framework: "crewai", lifecycleStatus: "active", dailyConsumption: STEADY_25 },
    { name: "Escalation Handler", framework: "autogen", lifecycleStatus: "active", dailyConsumption: STEADY_10 },
    { name: "Doc Extractor", framework: "generic_rest", lifecycleStatus: "active", dailyConsumption: STEADY_10 },
    { name: "Renewal Notifier", framework: "langchain", lifecycleStatus: "active", dailyConsumption: STEADY_10 },
    { name: "KYC Verifier", framework: "crewai", lifecycleStatus: "active", dailyConsumption: STEADY_10 },
    { name: "Chat Summarizer", framework: "autogen", lifecycleStatus: "active", dailyConsumption: STEADY_10 },
    { name: "Refund Processor", framework: "generic_rest", lifecycleStatus: "active", dailyConsumption: STEADY_10 },
    { name: "Lead Scorer", framework: "langchain", lifecycleStatus: "active", dailyConsumption: STEADY_10 },
    { name: "SLA Monitor", framework: "crewai", lifecycleStatus: "active", dailyConsumption: STEADY_10 },
  ],
};

/** Tenant 3: over-cap — total consumption has already exceeded allocation (edge case: balance shows zero, not negative). */
const OVER_CAP_TENANT: MockTenantFixture = {
  slug: "wo074-fixture-over-cap",
  name: "WO-074 Fixture — Over-Cap Org",
  totalAllocated: 500,
  agents: [
    { name: "Runaway Batch Job", framework: "langchain", lifecycleStatus: "active", dailyConsumption: STEADY_25 },
    { name: "Overactive Poller", framework: "crewai", lifecycleStatus: "active", dailyConsumption: STEADY_25 },
    { name: "Alert Spammer", framework: "autogen", lifecycleStatus: "active", dailyConsumption: STEADY_10 },
    { name: "Excess Retry Bot", framework: "generic_rest", lifecycleStatus: "active", dailyConsumption: STEADY_10 },
    { name: "Overprovisioned Worker", framework: "langchain", lifecycleStatus: "active", dailyConsumption: STEADY_10 },
    { name: "Zombie Process Agent", framework: "crewai", lifecycleStatus: "paused", dailyConsumption: STEADY_10 },
    { name: "Unthrottled Fetcher", framework: "autogen", lifecycleStatus: "active", dailyConsumption: STEADY_10 },
    { name: "Cost Blowout Agent", framework: "generic_rest", lifecycleStatus: "active", dailyConsumption: STEADY_10 },
    { name: "Legacy Cron Bot", framework: "langchain", lifecycleStatus: "active", dailyConsumption: STEADY_10 },
    { name: "Uncapped Scraper", framework: "crewai", lifecycleStatus: "active", dailyConsumption: STEADY_10 },
  ],
};

export const USAGE_DASHBOARD_MOCK_TENANTS: MockTenantFixture[] = [HEALTHY_TENANT, NEAR_CAP_TENANT, OVER_CAP_TENANT];

export function totalConsumption(agent: MockAgentFixture): number {
  return agent.dailyConsumption.reduce((sum, credits) => sum + credits, 0);
}
