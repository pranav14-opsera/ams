import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AgentHealthDashboardPage from "./page";
import { expectNoA11yViolations } from "@/test/a11y/axe-setup";
import fixtures from "@/test/fixtures/dashboard/agent-health-fixtures.json";
import type { AgentHealthViewModel } from "@/types/dashboard";

const agents = (fixtures.records as AgentHealthViewModel[]).slice(0, 6);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const mockUseFleetHealthQuery = vi.fn();
vi.mock("@/hooks/useFleetHealthQuery", () => ({
  useFleetHealthQuery: (...args: unknown[]) => mockUseFleetHealthQuery(...args),
}));

const mockUseHealthWebSocket = vi.fn();
vi.mock("@/hooks/useHealthWebSocket", () => ({
  useHealthWebSocket: () => mockUseHealthWebSocket(),
}));

function baseSnapshot() {
  return { summary: { totalAgents: agents.length, activePct: 50, degradedPct: 17, errorPct: 17, pausedPct: 16, retiredPct: 0 }, agents, total: agents.length, limit: 50, offset: 0, servedFromCache: false };
}

describe("AgentHealthDashboardPage", () => {
  it("shows a loading state before any data has arrived", () => {
    mockUseFleetHealthQuery.mockReturnValue({ isLoading: true, isError: false, data: undefined });
    mockUseHealthWebSocket.mockReturnValue({ latest: undefined, connectionState: "connecting", isStale: false });

    render(<AgentHealthDashboardPage />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading agent health");
  });

  it("shows an error state when the REST fetch fails and no live data has arrived either", () => {
    mockUseFleetHealthQuery.mockReturnValue({ isLoading: false, isError: true, data: undefined });
    mockUseHealthWebSocket.mockReturnValue({ latest: undefined, connectionState: "error", isStale: false });

    render(<AgentHealthDashboardPage />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("renders the fleet summary and agent list once REST data has loaded", () => {
    mockUseFleetHealthQuery.mockReturnValue({ isLoading: false, isError: false, data: baseSnapshot() });
    mockUseHealthWebSocket.mockReturnValue({ latest: undefined, connectionState: "connecting", isStale: false });

    render(<AgentHealthDashboardPage />);
    expect(screen.getByRole("group", { name: "Fleet health summary" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(agents.length);
  });

  it("prefers the live WebSocket snapshot over the REST data once it arrives", () => {
    mockUseFleetHealthQuery.mockReturnValue({ isLoading: false, isError: false, data: baseSnapshot() });
    const liveSnapshot = { ...baseSnapshot(), agents: agents.slice(0, 2) };
    mockUseHealthWebSocket.mockReturnValue({ latest: liveSnapshot, connectionState: "connected", isStale: false });

    render(<AgentHealthDashboardPage />);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByRole("status")).toHaveTextContent("Live");
  });

  it("sorts degraded/error agents to the top of the list", () => {
    mockUseFleetHealthQuery.mockReturnValue({ isLoading: false, isError: false, data: baseSnapshot() });
    mockUseHealthWebSocket.mockReturnValue({ latest: undefined, connectionState: "connecting", isStale: false });

    render(<AgentHealthDashboardPage />);
    const items = screen.getAllByRole("listitem");
    const firstBadgeText = items[0]?.textContent ?? "";
    expect(firstBadgeText).toMatch(/Error|Degraded/);
  });

  it("indicates staleness in the status line when the live feed hasn't updated recently", () => {
    mockUseFleetHealthQuery.mockReturnValue({ isLoading: false, isError: false, data: baseSnapshot() });
    mockUseHealthWebSocket.mockReturnValue({ latest: baseSnapshot(), connectionState: "connected", isStale: true });

    render(<AgentHealthDashboardPage />);
    expect(screen.getByRole("status")).toHaveTextContent("data may be out of date");
  });

  it("has zero critical/serious WCAG 2.1 AA violations (axe-core)", async () => {
    mockUseFleetHealthQuery.mockReturnValue({ isLoading: false, isError: false, data: baseSnapshot() });
    mockUseHealthWebSocket.mockReturnValue({ latest: undefined, connectionState: "connecting", isStale: false });

    const { container } = render(<AgentHealthDashboardPage />);
    await expectNoA11yViolations(container);
  });
});
