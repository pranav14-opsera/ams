import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import OrgUsageDashboardPage from "./page";
import { expectNoA11yViolations } from "@/test/a11y/axe-setup";
import type { OrgUsageSummary } from "@/types/dashboard";

const mockUseOrgUsageQuery = vi.fn();
vi.mock("@/hooks/useOrgUsageQuery", () => ({
  useOrgUsageQuery: (...args: unknown[]) => mockUseOrgUsageQuery(...args),
}));

const mockUseOrgUsageSubscription = vi.fn();
vi.mock("@/hooks/useOrgUsageSubscription", () => ({
  useOrgUsageSubscription: () => mockUseOrgUsageSubscription(),
}));

function baseSummary(overrides: Partial<OrgUsageSummary> = {}): OrgUsageSummary {
  return {
    balance: { total: 1000, consumed: 400, remaining: 600 },
    burnRate: { creditsPerDay: 20, projectedExhaustionDate: "2026-09-19" },
    activeAgents: 3,
    consumptionTrend: [{ date: "2026-08-01T00:00:00.000Z", credits: 40 }],
    agentBreakdown: [{ agentId: "agent-1", agentName: "Agent One", framework: "langchain", creditsConsumed: 40 }],
    servedFromCache: false,
    ...overrides,
  };
}

describe("OrgUsageDashboardPage", () => {
  it("shows a loading state before any data has arrived", () => {
    mockUseOrgUsageQuery.mockReturnValue({ isLoading: true, isError: false, data: undefined });
    mockUseOrgUsageSubscription.mockReturnValue({ latest: undefined, connectionState: "connecting", isStale: false });

    render(<OrgUsageDashboardPage />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading organization usage");
  });

  it("shows an error state when the initial load fails and nothing else is available", () => {
    mockUseOrgUsageQuery.mockReturnValue({ isLoading: false, isError: true, data: undefined });
    mockUseOrgUsageSubscription.mockReturnValue({ latest: undefined, connectionState: "offline", isStale: false });

    render(<OrgUsageDashboardPage />);
    expect(screen.getByRole("alert")).toHaveTextContent("Unable to load the organization usage dashboard");
  });

  it("edge case: a brand-new tenant with zero consumption history shows the onboarding empty state, not broken charts", () => {
    mockUseOrgUsageQuery.mockReturnValue({ isLoading: false, isError: false, data: baseSummary({ consumptionTrend: [], agentBreakdown: [] }) });
    mockUseOrgUsageSubscription.mockReturnValue({ latest: undefined, connectionState: "connected", isStale: false });

    render(<OrgUsageDashboardPage />);
    expect(screen.getByText(/No usage recorded yet/)).toBeInTheDocument();
  });

  it("renders KPI cards, trend chart, and agent breakdown once data has loaded", () => {
    mockUseOrgUsageQuery.mockReturnValue({ isLoading: false, isError: false, data: baseSummary() });
    mockUseOrgUsageSubscription.mockReturnValue({ latest: undefined, connectionState: "connected", isStale: false });

    render(<OrgUsageDashboardPage />);
    expect(screen.getByText("Total Credit Balance")).toBeInTheDocument();
    expect(screen.getByText("Credit Consumption Trend")).toBeInTheDocument();
    expect(screen.getByText("Consumption by Agent")).toBeInTheDocument();
  });

  it("merges a live WebSocket balance/burn-rate update on top of the REST snapshot", () => {
    mockUseOrgUsageQuery.mockReturnValue({ isLoading: false, isError: false, data: baseSummary() });
    mockUseOrgUsageSubscription.mockReturnValue({
      latest: { balance: { total: 1000, consumed: 999, remaining: 1 }, burnRate: { creditsPerDay: 999, projectedExhaustionDate: null }, latestConsumption: null },
      connectionState: "connected",
      isStale: false,
    });

    render(<OrgUsageDashboardPage />);
    expect(screen.getByLabelText("Credits Consumed (Period): 999")).toBeInTheDocument();
  });

  it("shows a stale-data indicator when the connection has dropped and no fresh update has arrived", () => {
    mockUseOrgUsageQuery.mockReturnValue({ isLoading: false, isError: false, data: baseSummary() });
    mockUseOrgUsageSubscription.mockReturnValue({ latest: undefined, connectionState: "reconnecting", isStale: true });

    render(<OrgUsageDashboardPage />);
    expect(screen.getByText(/reconnecting/i)).toBeInTheDocument();
    expect(screen.getByText(/data may be out of date/)).toBeInTheDocument();
  });

  it("has no axe-core accessibility violations when fully loaded", async () => {
    mockUseOrgUsageQuery.mockReturnValue({ isLoading: false, isError: false, data: baseSummary() });
    mockUseOrgUsageSubscription.mockReturnValue({ latest: undefined, connectionState: "connected", isStale: false });

    const { container } = render(<OrgUsageDashboardPage />);
    await expectNoA11yViolations(container);
  });
});
