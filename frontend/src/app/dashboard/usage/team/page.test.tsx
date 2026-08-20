import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import TeamUsageDashboardPage from "./page";
import { expectNoA11yViolations } from "@/test/a11y/axe-setup";
import { useAppStore } from "@/stores/app-store";
import type { TeamUsageSummary } from "@/types/dashboard";

const mockUseTeamUsageQuery = vi.fn();
vi.mock("@/hooks/useTeamUsageQuery", () => ({
  useTeamUsageQuery: (...args: unknown[]) => mockUseTeamUsageQuery(...args),
  useSelectableTeamsQuery: () => ({
    data: [
      { id: "team-1", name: "Team Alpha" },
      { id: "team-2", name: "Team Bravo" },
    ],
  }),
}));

const mockUseTeamUsageSubscription = vi.fn();
vi.mock("@/hooks/useTeamUsageSubscription", () => ({
  useTeamUsageSubscription: (...args: unknown[]) => mockUseTeamUsageSubscription(...args),
}));

function baseSummary(overrides: Partial<TeamUsageSummary> = {}): TeamUsageSummary {
  return {
    team: { id: "team-1", name: "Team Alpha" },
    balance: { allocated: 1000, consumed: 400, remaining: 600, utilizationPct: 40 },
    burnRate: { creditsPerDay: 20 },
    agentCount: 3,
    consumptionTrend: [{ date: "2026-08-01T00:00:00.000Z", credits: 40 }],
    agentComparison: [{ agentId: "agent-1", agentName: "Agent One", framework: "langchain", creditsConsumed: 40, isAboveThreshold: false }],
    filtersApplied: { period: "30d", granularity: "daily" },
    servedFromCache: false,
    ...overrides,
  };
}

describe("TeamUsageDashboardPage", () => {
  it("shows a loading state before any data has arrived", () => {
    mockUseTeamUsageQuery.mockReturnValue({ isLoading: true, isError: false, data: undefined });
    mockUseTeamUsageSubscription.mockReturnValue({ latest: undefined, connectionState: "connecting", isStale: false });

    render(<TeamUsageDashboardPage />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading team usage");
  });

  it("shows an error state when the initial load fails and nothing else is available", () => {
    mockUseTeamUsageQuery.mockReturnValue({ isLoading: false, isError: true, data: undefined });
    mockUseTeamUsageSubscription.mockReturnValue({ latest: undefined, connectionState: "offline", isStale: false });

    render(<TeamUsageDashboardPage />);
    expect(screen.getByRole("alert")).toHaveTextContent("Unable to load the team usage dashboard");
  });

  it("edge case: no teams configured for the tenant shows a guidance empty state, not a raw error", () => {
    mockUseTeamUsageQuery.mockReturnValue({ isLoading: false, isError: false, data: undefined });
    mockUseTeamUsageSubscription.mockReturnValue({ latest: undefined, connectionState: "connected", isStale: false });

    render(<TeamUsageDashboardPage />);
    expect(screen.getByRole("status")).toHaveTextContent("No teams are configured");
  });

  it("renders the team name, KPI cards, filter panel, trend chart, and agent comparison once data has loaded", () => {
    mockUseTeamUsageQuery.mockReturnValue({ isLoading: false, isError: false, data: baseSummary() });
    mockUseTeamUsageSubscription.mockReturnValue({ latest: undefined, connectionState: "connected", isStale: false });

    render(<TeamUsageDashboardPage />);
    expect(screen.getByText("Team Alpha — Usage")).toBeInTheDocument();
    expect(screen.getByText("Team Credit Balance")).toBeInTheDocument();
    expect(screen.getByText("Team Consumption Trend")).toBeInTheDocument();
    expect(screen.getByText("Agent Comparison")).toBeInTheDocument();
  });

  it("merges a live WebSocket balance/burn-rate update on top of the REST snapshot", () => {
    mockUseTeamUsageQuery.mockReturnValue({ isLoading: false, isError: false, data: baseSummary() });
    mockUseTeamUsageSubscription.mockReturnValue({
      latest: { teamId: "team-1", balance: { allocated: 1000, consumed: 999, remaining: 1, utilizationPct: 99 }, burnRate: { creditsPerDay: 999 }, latestConsumption: null },
      connectionState: "connected",
      isStale: false,
    });

    render(<TeamUsageDashboardPage />);
    expect(screen.getByLabelText("Consumed (Period): 999")).toBeInTheDocument();
  });

  it("shows a stale-data indicator when the connection has dropped and no fresh update has arrived", () => {
    mockUseTeamUsageQuery.mockReturnValue({ isLoading: false, isError: false, data: baseSummary() });
    mockUseTeamUsageSubscription.mockReturnValue({ latest: undefined, connectionState: "reconnecting", isStale: true });

    render(<TeamUsageDashboardPage />);
    expect(screen.getByText(/reconnecting/i)).toBeInTheDocument();
    expect(screen.getByText(/data may be out of date/)).toBeInTheDocument();
  });

  it("AC 6: shows the team selector for a Platform Administrator", () => {
    useAppStore.setState((state) => ({ auth: { ...state.auth, roles: ["platform_admin"] } }));
    mockUseTeamUsageQuery.mockReturnValue({ isLoading: false, isError: false, data: baseSummary() });
    mockUseTeamUsageSubscription.mockReturnValue({ latest: undefined, connectionState: "connected", isStale: false });

    render(<TeamUsageDashboardPage />);
    expect(screen.getByLabelText("Select team")).toBeInTheDocument();
  });

  it("has no axe-core accessibility violations when fully loaded", async () => {
    mockUseTeamUsageQuery.mockReturnValue({ isLoading: false, isError: false, data: baseSummary() });
    mockUseTeamUsageSubscription.mockReturnValue({ latest: undefined, connectionState: "connected", isStale: false });

    const { container } = render(<TeamUsageDashboardPage />);
    await expectNoA11yViolations(container);
  });
});
