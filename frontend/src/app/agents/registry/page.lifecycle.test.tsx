import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import AgentRegistryPage from "./page";
import { env } from "@/env";
import lifecycleAgents from "@/test/fixtures/agents/lifecycle-agents.json";
import transitionSuccess from "@/test/fixtures/agents/lifecycle-transition-success.json";
import transitionConflict from "@/test/fixtures/agents/lifecycle-transition-conflict.json";
import bulkPartialFailure from "@/test/fixtures/agents/bulk-lifecycle-partial-failure.json";
import type { AgentRegistryEntry } from "@/types/dashboard";

const base = env.NEXT_PUBLIC_API_BASE_URL;
const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "warn" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const mockPush = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mockPush }) }));

const mockUseAgentHealthSocket = vi.fn();
vi.mock("@/hooks/useAgentHealthSocket", () => ({ useAgentHealthSocket: () => mockUseAgentHealthSocket() }));

const activeAgent = lifecycleAgents.active as AgentRegistryEntry;
const pausedAgent = lifecycleAgents.paused as AgentRegistryEntry;
const registryAgents = [activeAgent, pausedAgent];

function registryHandler(agents: AgentRegistryEntry[] = registryAgents) {
  return http.get(`${base}/api/v1/agents`, () =>
    HttpResponse.json({ data: agents, pagination: { page: 1, pageSize: 25, total: agents.length, totalPages: 1 } }),
  );
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderPage() {
  return render(<AgentRegistryPage />, { wrapper });
}

describe("AgentRegistryPage — lifecycle management (WO-081)", () => {
  beforeAll(() => {
    mockUseAgentHealthSocket.mockReturnValue({ connectionState: "connected", statusUpdates: new Map() });
  });

  it("individual pause flow: action menu -> confirmation dialog (with in-flight warning) -> PATCH -> row reflects the new status", async () => {
    let patchedBody: unknown;
    server.use(
      registryHandler(),
      http.patch(`${base}/api/v1/agents/:id/lifecycle`, async ({ request, params }) => {
        patchedBody = await request.json();
        expect(params.id).toBe(activeAgent.id);
        return HttpResponse.json(transitionSuccess);
      }),
    );

    renderPage();
    await waitFor(() => expect(screen.getByText(activeAgent.name)).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: `Actions for ${activeAgent.name}` }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Pause/ }));

    expect(screen.getByRole("heading", { name: "Pause agent?" })).toBeInTheDocument();
    expect(screen.getByText(/In-flight operations will complete gracefully/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(patchedBody).toEqual({ targetStatus: "paused", justification: undefined }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Pause agent?" })).not.toBeInTheDocument());
  });

  it("individual resume flow: Paused agent's menu offers Resume, confirming calls PATCH with targetStatus 'active'", async () => {
    let patchedBody: unknown;
    server.use(
      registryHandler(),
      http.patch(`${base}/api/v1/agents/:id/lifecycle`, async ({ request }) => {
        patchedBody = await request.json();
        return HttpResponse.json({ ...transitionSuccess, id: pausedAgent.id, lifecycleStatus: "active" });
      }),
    );

    renderPage();
    await waitFor(() => expect(screen.getByText(pausedAgent.name)).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: `Actions for ${pausedAgent.name}` }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Resume/ }));
    // Resume never carries the in-flight warning (only Active->Paused does).
    expect(screen.queryByText(/in-flight/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(patchedBody).toEqual({ targetStatus: "active", justification: undefined }));
  });

  it("409 conflict: shows 'Agent status has changed' and refreshes the registry", async () => {
    let getCallCount = 0;
    server.use(
      http.get(`${base}/api/v1/agents`, () => {
        getCallCount += 1;
        return HttpResponse.json({ data: registryAgents, pagination: { page: 1, pageSize: 25, total: registryAgents.length, totalPages: 1 } });
      }),
      http.patch(`${base}/api/v1/agents/:id/lifecycle`, () => HttpResponse.json(transitionConflict, { status: 409 })),
    );

    renderPage();
    await waitFor(() => expect(screen.getByText(activeAgent.name)).toBeInTheDocument());
    const initialGetCount = getCallCount;

    await userEvent.click(screen.getByRole("button", { name: `Actions for ${activeAgent.name}` }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Pause/ }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Agent status has changed. Please review and try again."));
    await waitFor(() => expect(getCallCount).toBeGreaterThan(initialGetCount));
  });

  it("bulk retire with partial failure: toolbar action -> bulk confirmation -> POST -> results dialog shows 2 successes and 1 failure with error detail", async () => {
    const bulkAgents: AgentRegistryEntry[] = [
      { ...activeAgent, id: "a0001aaaa-0000-0000-0000-000000000000", name: "bulk-agent-1" },
      { ...activeAgent, id: "a0002aaaa-0000-0000-0000-000000000000", name: "bulk-agent-2" },
      { ...activeAgent, id: "a0003aaaa-0000-0000-0000-000000000000", name: "bulk-agent-3" },
    ];
    let postedBody: unknown;
    server.use(
      registryHandler(bulkAgents),
      http.post(`${base}/api/v1/agents/bulk-lifecycle`, async ({ request }) => {
        postedBody = await request.json();
        return HttpResponse.json(bulkPartialFailure);
      }),
    );

    renderPage();
    await waitFor(() => expect(screen.getByText("bulk-agent-1")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("checkbox", { name: "Select all agents on this page" }));
    await userEvent.click(screen.getByRole("button", { name: "Retire" }));

    expect(screen.getByRole("heading", { name: "Retire 3 agents?" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() =>
      expect((postedBody as { agentIds: string[] }).agentIds.sort()).toEqual(
        ["a0001aaaa-0000-0000-0000-000000000000", "a0002aaaa-0000-0000-0000-000000000000", "a0003aaaa-0000-0000-0000-000000000000"].sort(),
      ),
    );

    const resultsDialog = await screen.findByRole("dialog");
    expect(within(resultsDialog).getByText("2 succeeded, 1 failed out of 3 agents.")).toBeInTheDocument();
  });

  it("Connecting and Decommissioned agents get no action menu at all", async () => {
    const noActionAgents = [lifecycleAgents.connecting as AgentRegistryEntry, lifecycleAgents.decommissioned as AgentRegistryEntry];
    server.use(registryHandler(noActionAgents));

    renderPage();
    await waitFor(() => expect(screen.getByText(noActionAgents[0]!.name)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /Actions for/ })).not.toBeInTheDocument();
  });
});
