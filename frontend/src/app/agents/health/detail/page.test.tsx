import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import AgentHealthDetailPage from "./page";
import { expectNoA11yViolations } from "@/test/a11y/axe-setup";

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => new URLSearchParams("agentId=agent-1"),
}));

const mockUseAgentHealthHistoryQuery = vi.fn();
const mockUseAgentTracesQuery = vi.fn();
const mockUseAgentLifecycleHistoryQuery = vi.fn();
vi.mock("@/hooks/useAgentHealthDetailQueries", () => ({
  useAgentHealthHistoryQuery: (...args: unknown[]) => mockUseAgentHealthHistoryQuery(...args),
  useAgentTracesQuery: (...args: unknown[]) => mockUseAgentTracesQuery(...args),
  useAgentLifecycleHistoryQuery: (...args: unknown[]) => mockUseAgentLifecycleHistoryQuery(...args),
}));

function setAllLoading() {
  mockUseAgentHealthHistoryQuery.mockReturnValue({ isLoading: true, isError: false, data: undefined });
  mockUseAgentTracesQuery.mockReturnValue({ isLoading: true, data: undefined });
  mockUseAgentLifecycleHistoryQuery.mockReturnValue({ isLoading: true, data: undefined });
}

function setAllLoaded() {
  mockUseAgentHealthHistoryQuery.mockReturnValue({
    isLoading: false,
    isError: false,
    data: { agentId: "agent-1", range: "24h", points: [{ bucket: "2026-08-16T00:00:00Z", latencyP50Ms: 100, latencyP99Ms: 200, errorRateAvg: 0, tokenConsumptionTotal: 10, toolCallSuccessRateAvg: 1 }], qualityScore: 92, driftStatus: "stable" },
  });
  mockUseAgentTracesQuery.mockReturnValue({ isLoading: false, data: { rows: [], total: 0 } });
  mockUseAgentLifecycleHistoryQuery.mockReturnValue({ isLoading: false, data: [] });
}

describe("AgentHealthDetailPage", () => {
  it("shows loading states before data has arrived", () => {
    setAllLoading();
    render(<AgentHealthDetailPage />);
    expect(screen.getByText("Loading health history…")).toBeInTheDocument();
  });

  it("shows an error alert when the health history fetch fails", () => {
    mockUseAgentHealthHistoryQuery.mockReturnValue({ isLoading: false, isError: true, data: undefined });
    mockUseAgentTracesQuery.mockReturnValue({ isLoading: false, data: undefined });
    mockUseAgentLifecycleHistoryQuery.mockReturnValue({ isLoading: false, data: undefined });

    render(<AgentHealthDetailPage />);
    expect(screen.getByRole("alert")).toHaveTextContent("Unable to load health history");
  });

  it("renders the quality score, chart, traces, and lifecycle sections once loaded", () => {
    setAllLoaded();
    render(<AgentHealthDetailPage />);
    expect(screen.getByText("92")).toBeInTheDocument();
    expect(screen.getByText("Recent Execution Traces")).toBeInTheDocument();
    expect(screen.getByText("Lifecycle History")).toBeInTheDocument();
  });

  it("renders an honest 'not yet available' note for alerts rather than fabricated alert data", () => {
    setAllLoaded();
    render(<AgentHealthDetailPage />);
    expect(screen.getByText("Alerting is not yet available for this agent.")).toBeInTheDocument();
  });

  it("has zero critical/serious WCAG 2.1 AA violations (axe-core)", async () => {
    setAllLoaded();
    const { container } = render(<AgentHealthDetailPage />);
    await expectNoA11yViolations(container);
  });
});
