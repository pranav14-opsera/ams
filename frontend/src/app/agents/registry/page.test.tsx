import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AgentRegistryPage from "./page";
import { expectNoA11yViolations } from "@/test/a11y/axe-setup";
import fixtures from "@/test/fixtures/agents/agent-registry-fixtures.json";
import type { AgentRegistryEntry } from "@/types/dashboard";

const agents = (fixtures.records as AgentRegistryEntry[]).slice(0, 6);

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

const mockRefetch = vi.fn();
const mockUseAgentRegistryQuery = vi.fn();
vi.mock("@/hooks/useAgentRegistryQuery", () => ({
  useAgentRegistryQuery: (...args: unknown[]) => mockUseAgentRegistryQuery(...args),
}));

const mockUseAgentHealthSocket = vi.fn();
vi.mock("@/hooks/useAgentHealthSocket", () => ({
  useAgentHealthSocket: () => mockUseAgentHealthSocket(),
}));

function baseResult(overrides: Record<string, unknown> = {}) {
  return {
    isLoading: false,
    isSuccess: true,
    isError: false,
    error: null,
    refetch: mockRefetch,
    data: { data: agents, pagination: { page: 1, pageSize: 25, total: agents.length, totalPages: 1 } },
    ...overrides,
  };
}

describe("AgentRegistryPage", () => {
  afterEach(() => {
    mockPush.mockClear();
    mockRefetch.mockClear();
  });

  it("shows a loading state before any data has arrived", () => {
    mockUseAgentRegistryQuery.mockReturnValue(baseResult({ isLoading: true, isSuccess: false, data: undefined }));
    mockUseAgentHealthSocket.mockReturnValue({ connectionState: "connecting", statusUpdates: new Map() });

    render(<AgentRegistryPage />);
    expect(screen.getByText("Loading agent registry…")).toBeInTheDocument();
  });

  it("renders the table and pagination once data has loaded", async () => {
    mockUseAgentRegistryQuery.mockReturnValue(baseResult());
    mockUseAgentHealthSocket.mockReturnValue({ connectionState: "connected", statusUpdates: new Map() });

    render(<AgentRegistryPage />);
    await waitFor(() => expect(screen.getAllByRole("row").length).toBeGreaterThan(1));
    expect(screen.getByText(`Showing 1–${agents.length} of ${agents.length} agents`)).toBeInTheDocument();
  });

  it("shows the Register New Agent CTA above the table", () => {
    mockUseAgentRegistryQuery.mockReturnValue(baseResult());
    mockUseAgentHealthSocket.mockReturnValue({ connectionState: "connected", statusUpdates: new Map() });

    render(<AgentRegistryPage />);
    expect(screen.getByRole("link", { name: "Register New Agent" })).toHaveAttribute("href", "/agents/register");
  });

  it("redirects to /login on a 401 response", async () => {
    const error = Object.assign(new Error("unauthorized"), { status: 401 });
    mockUseAgentRegistryQuery.mockReturnValue(baseResult({ isSuccess: false, isError: true, error, data: undefined }));
    mockUseAgentHealthSocket.mockReturnValue({ connectionState: "connected", statusUpdates: new Map() });

    render(<AgentRegistryPage />);
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/login"));
  });

  it("shows an inline permission error on a 403 response", () => {
    const error = Object.assign(new Error("forbidden"), { status: 403 });
    mockUseAgentRegistryQuery.mockReturnValue(baseResult({ isSuccess: false, isError: true, error, data: undefined }));
    mockUseAgentHealthSocket.mockReturnValue({ connectionState: "connected", statusUpdates: new Map() });

    render(<AgentRegistryPage />);
    expect(screen.getByRole("alert")).toHaveTextContent(/don't have permission/);
  });

  it("shows a retry banner on a 500 response, and refetches when Retry is clicked", async () => {
    const error = Object.assign(new Error("server error"), { status: 500 });
    mockUseAgentRegistryQuery.mockReturnValue(baseResult({ isSuccess: false, isError: true, error, data: undefined }));
    mockUseAgentHealthSocket.mockReturnValue({ connectionState: "connected", statusUpdates: new Map() });

    render(<AgentRegistryPage />);
    expect(screen.getByRole("alert")).toHaveTextContent(/Something went wrong/);
    const { default: userEvent } = await import("@testing-library/user-event");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mockRefetch).toHaveBeenCalled();
  });

  it("shows a reconnecting banner when the WebSocket connection is degraded", () => {
    mockUseAgentRegistryQuery.mockReturnValue(baseResult());
    mockUseAgentHealthSocket.mockReturnValue({ connectionState: "reconnecting", statusUpdates: new Map() });

    render(<AgentRegistryPage />);
    expect(screen.getByText(/Live updates paused — reconnecting/)).toBeInTheDocument();
  });

  it("shows a degraded-updates banner when the WebSocket errors out", () => {
    mockUseAgentRegistryQuery.mockReturnValue(baseResult());
    mockUseAgentHealthSocket.mockReturnValue({ connectionState: "error", statusUpdates: new Map() });

    render(<AgentRegistryPage />);
    expect(screen.getByText(/Live status updates are currently unavailable/)).toBeInTheDocument();
  });

  it("shows the 'register your first agent' empty state only when there are zero agents AND no filters applied", () => {
    mockUseAgentRegistryQuery.mockReturnValue(baseResult({ data: { data: [], pagination: { page: 1, pageSize: 25, total: 0, totalPages: 0 } } }));
    mockUseAgentHealthSocket.mockReturnValue({ connectionState: "connected", statusUpdates: new Map() });

    render(<AgentRegistryPage />);
    expect(screen.getByRole("link", { name: "Register your first agent" })).toBeInTheDocument();
  });

  it("merges a real-time WebSocket status update into the displayed row", async () => {
    mockUseAgentRegistryQuery.mockReturnValue(baseResult());
    const updatedAgent = agents[0]!;
    mockUseAgentHealthSocket.mockReturnValue({
      connectionState: "connected",
      statusUpdates: new Map([[updatedAgent.id, { status: "decommissioned", lastSeen: "2026-08-20T13:00:00.000Z" }]]),
    });

    render(<AgentRegistryPage />);
    await waitFor(() => expect(screen.getAllByText("Decommissioned").length).toBeGreaterThan(0));
  });

  it("has zero critical/serious WCAG 2.1 AA violations (axe-core) — loaded state", async () => {
    mockUseAgentRegistryQuery.mockReturnValue(baseResult());
    mockUseAgentHealthSocket.mockReturnValue({ connectionState: "connected", statusUpdates: new Map() });

    const { container } = render(<AgentRegistryPage />);
    await waitFor(() => expect(screen.getAllByRole("row").length).toBeGreaterThan(1));
    await expectNoA11yViolations(container);
  });

  it("has zero critical/serious WCAG 2.1 AA violations (axe-core) — empty state", async () => {
    mockUseAgentRegistryQuery.mockReturnValue(baseResult({ data: { data: [], pagination: { page: 1, pageSize: 25, total: 0, totalPages: 0 } } }));
    mockUseAgentHealthSocket.mockReturnValue({ connectionState: "connected", statusUpdates: new Map() });

    const { container } = render(<AgentRegistryPage />);
    await waitFor(() => expect(screen.getByRole("link", { name: "Register your first agent" })).toBeInTheDocument());
    await expectNoA11yViolations(container);
  });

  it("has zero critical/serious WCAG 2.1 AA violations (axe-core) — error state", async () => {
    const error = Object.assign(new Error("server error"), { status: 500 });
    mockUseAgentRegistryQuery.mockReturnValue(baseResult({ isSuccess: false, isError: true, error, data: undefined }));
    mockUseAgentHealthSocket.mockReturnValue({ connectionState: "connected", statusUpdates: new Map() });

    const { container } = render(<AgentRegistryPage />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    await expectNoA11yViolations(container);
  });

  it("has zero critical/serious WCAG 2.1 AA violations (axe-core) — loading state", async () => {
    mockUseAgentRegistryQuery.mockReturnValue(baseResult({ isLoading: true, isSuccess: false, data: undefined }));
    mockUseAgentHealthSocket.mockReturnValue({ connectionState: "connecting", statusUpdates: new Map() });

    const { container } = render(<AgentRegistryPage />);
    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
    await expectNoA11yViolations(container);
  });
});
