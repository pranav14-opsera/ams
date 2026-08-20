// WO-075: team-scoped usage dashboard fixtures — 3 teams per tenant, 5+
// agents per team (except the deliberate zero-agent edge case team),
// varied framework types, 30 days of consumption history, and one agent
// per "hotspot" team engineered to sit above 2x its team's mean (AC 4's
// own "exceeding team average by more than 2x" visual-indicator case).
// Shaped as plain data (same reasoning as usage-dashboard-mock-data.ts)
// so unit tests and the real-Postgres integration test share one source
// of truth.

export interface MockTeamUsageAgentFixture {
  name: string;
  framework: "langchain" | "crewai" | "autogen" | "generic_rest";
  actionType: string;
  /** Credits consumed per day for each of the last 30 days — index 0 is 30 days ago, index 29 is today. */
  dailyConsumption: number[];
}

export interface MockTeamUsageTeamFixture {
  name: string;
  /** Monthly budget allocation for the current effective month — 0 means "deliberately never budgeted" (edge case). */
  budgetAllocated: number;
  agents: MockTeamUsageAgentFixture[];
}

const STEADY_10 = Array.from({ length: 30 }, () => 10);
const STEADY_20 = Array.from({ length: 30 }, () => 20);
const HOTSPOT_80 = Array.from({ length: 30 }, () => 80); // engineered to sit well above 2x the team's mean.
const THIRTY_ZEROS = Array.from({ length: 30 }, () => 0);

/** Team A: a normal, healthy team with a hotspot agent (AC 4's 2x-threshold case). */
const TEAM_A: MockTeamUsageTeamFixture = {
  name: "WO-075 Fixture — Team Alpha",
  budgetAllocated: 10_000,
  agents: [
    { name: "Alpha Claims Bot", framework: "langchain", actionType: "agent_execution", dailyConsumption: STEADY_10 },
    { name: "Alpha Invoice Bot", framework: "crewai", actionType: "agent_execution", dailyConsumption: STEADY_10 },
    { name: "Alpha Support Bot", framework: "autogen", actionType: "tool_call", dailyConsumption: STEADY_20 },
    { name: "Alpha REST Connector", framework: "generic_rest", actionType: "tool_call", dailyConsumption: STEADY_10 },
    { name: "Alpha Runaway Job", framework: "langchain", actionType: "agent_execution", dailyConsumption: HOTSPOT_80 }, // edge case: > 2x team mean
    { name: "Alpha Idle Agent", framework: "crewai", actionType: "agent_execution", dailyConsumption: THIRTY_ZEROS }, // edge case: zero consumption, still in roster
  ],
};

/** Team B: near-cap, more evenly distributed, no hotspot — exercises "no agent above threshold" and cross-team isolation as the OTHER team in the same tenant. */
const TEAM_B: MockTeamUsageTeamFixture = {
  name: "WO-075 Fixture — Team Bravo",
  budgetAllocated: 2_000,
  agents: [
    { name: "Bravo Batch Worker", framework: "langchain", actionType: "agent_execution", dailyConsumption: STEADY_20 },
    { name: "Bravo Reconciler", framework: "crewai", actionType: "agent_execution", dailyConsumption: STEADY_20 },
    { name: "Bravo Escalation Bot", framework: "autogen", actionType: "tool_call", dailyConsumption: STEADY_10 },
    { name: "Bravo Doc Extractor", framework: "generic_rest", actionType: "tool_call", dailyConsumption: STEADY_10 },
    { name: "Bravo KYC Verifier", framework: "langchain", actionType: "agent_execution", dailyConsumption: STEADY_10 },
  ],
};

/** Team C: zero-agent team — edge case: "zero-agent team empty state". */
const TEAM_C: MockTeamUsageTeamFixture = {
  name: "WO-075 Fixture — Team Charlie",
  budgetAllocated: 0, // edge case: never budgeted
  agents: [],
};

export const TEAM_USAGE_MOCK_TEAMS: MockTeamUsageTeamFixture[] = [TEAM_A, TEAM_B, TEAM_C];

export function totalTeamConsumption(team: MockTeamUsageTeamFixture): number {
  return team.agents.reduce((sum, agent) => sum + agent.dailyConsumption.reduce((s, c) => s + c, 0), 0);
}
