import { render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import AgentHealthDashboardPage from "./page";
import { expectNoA11yViolations } from "@/test/a11y/axe-setup";
import fixtures from "@/test/fixtures/dashboard/agent-health-fixtures.json";
import type { AgentHealthViewModel } from "@/types/dashboard";

const agents = (fixtures.records as AgentHealthViewModel[]).slice(0, 6);

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const mockFetchNextPage = vi.fn();
const mockUseFleetHealthInfiniteQuery = vi.fn();
vi.mock("@/hooks/useFleetHealthInfiniteQuery", () => ({
  useFleetHealthInfiniteQuery: (...args: unknown[]) => mockUseFleetHealthInfiniteQuery(...args),
}));

const mockUseHealthWebSocket = vi.fn();
vi.mock("@/hooks/useHealthWebSocket", () => ({
  useHealthWebSocket: () => mockUseHealthWebSocket(),
}));

// The real worker (useHealthMetricsWorker) tries to instantiate an actual
// Worker, which jsdom doesn't support — the hook already falls back to
// main-thread computation gracefully when Worker construction fails, so
// no mock is needed here; this exercises that real fallback path.

function baseSnapshot() {
  return { summary: { totalAgents: agents.length, activePct: 50, degradedPct: 17, errorPct: 17, pausedPct: 16, retiredPct: 0 }, agents, total: agents.length, limit: 50, offset: 0, servedFromCache: false };
}

function mockInfiniteQuery(overrides: Record<string, unknown> = {}) {
  mockUseFleetHealthInfiniteQuery.mockReturnValue({
    isLoading: false,
    isError: false,
    data: { pages: [baseSnapshot()] },
    fetchNextPage: mockFetchNextPage,
    hasNextPage: false,
    ...overrides,
  });
}

describe("AgentHealthDashboardPage", () => {
  // jsdom has no real layout engine — @tanstack/react-virtual computes its
  // visible range from the scroll container's measured height, which is
  // 0 without this stub, so it would render zero rows regardless of data.
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 800 });
  });

  it("shows a loading state before any data has arrived", () => {
    mockUseFleetHealthInfiniteQuery.mockReturnValue({ isLoading: true, isError: false, data: undefined, fetchNextPage: mockFetchNextPage, hasNextPage: false });
    mockUseHealthWebSocket.mockReturnValue({ latest: undefined, connectionState: "connecting", isStale: false });

    render(<AgentHealthDashboardPage />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading agent health");
  });

  it("shows an error state when the REST fetch fails and no live data has arrived either", () => {
    mockUseFleetHealthInfiniteQuery.mockReturnValue({ isLoading: false, isError: true, data: undefined, fetchNextPage: mockFetchNextPage, hasNextPage: false });
    mockUseHealthWebSocket.mockReturnValue({ latest: undefined, connectionState: "error", isStale: false });

    render(<AgentHealthDashboardPage />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("renders the fleet summary and virtualized agent grid once REST data has loaded", async () => {
    mockInfiniteQuery();
    mockUseHealthWebSocket.mockReturnValue({ latest: undefined, connectionState: "connecting", isStale: false });

    render(<AgentHealthDashboardPage />);
    expect(screen.getByRole("group", { name: "Fleet health summary" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(agents.length));
  });

  it("prefers the live WebSocket snapshot over the REST data once it arrives", async () => {
    mockInfiniteQuery();
    const liveSnapshot = { ...baseSnapshot(), agents: agents.slice(0, 2) };
    mockUseHealthWebSocket.mockReturnValue({ latest: liveSnapshot, connectionState: "connected", isStale: false });

    render(<AgentHealthDashboardPage />);
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(2));
    expect(screen.getByRole("status")).toHaveTextContent("Live");
  });

  it("indicates staleness in the status line when the live feed hasn't updated recently", () => {
    mockInfiniteQuery();
    mockUseHealthWebSocket.mockReturnValue({ latest: baseSnapshot(), connectionState: "connected", isStale: true });

    render(<AgentHealthDashboardPage />);
    expect(screen.getByRole("status")).toHaveTextContent("data may be out of date");
  });

  it("has zero critical/serious WCAG 2.1 AA violations (axe-core)", async () => {
    mockInfiniteQuery();
    mockUseHealthWebSocket.mockReturnValue({ latest: undefined, connectionState: "connecting", isStale: false });

    const { container } = render(<AgentHealthDashboardPage />);
    await waitFor(() => expect(screen.getAllByRole("row").length).toBeGreaterThan(0));
    await expectNoA11yViolations(container);
  });
});
