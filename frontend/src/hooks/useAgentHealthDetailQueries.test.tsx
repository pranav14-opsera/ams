import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentHealthHistoryQuery, useAgentLifecycleHistoryQuery, useAgentTracesQuery } from "./useAgentHealthDetailQueries";
import { useAppStore } from "@/stores/app-store";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useAgentHealthDetailQueries", () => {
  beforeEach(() => {
    useAppStore.setState({ auth: { userId: "u1", tenantId: "t1", roles: [], permissions: [], token: "jwt-abc" } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("useAgentHealthHistoryQuery fetches the correct URL with the range query param", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ agentId: "agent-1", range: "7d", points: [], qualityScore: null, driftStatus: "insufficient_data" }) });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useAgentHealthHistoryQuery("agent-1", "7d"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/api/v1/agents/agent-1/health/history?range=7d");
    expect(init.headers.Authorization).toBe("Bearer jwt-abc");
  });

  it("useAgentHealthHistoryQuery is disabled when agentId is empty", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useAgentHealthHistoryQuery("", "24h"), { wrapper });
    expect(result.current.fetchStatus).toBe("idle");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("useAgentTracesQuery includes the status filter in the URL when provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rows: [], total: 0 }) });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useAgentTracesQuery("agent-1", "failed"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/api/v1/agents/agent-1/traces?status=failed");
  });

  it("useAgentLifecycleHistoryQuery fetches the lifecycle-history endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useAgentLifecycleHistoryQuery("agent-1"), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/api/v1/agents/agent-1/lifecycle-history");
  });

  it("a non-ok response surfaces as a query error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));

    const { result } = renderHook(() => useAgentTracesQuery("agent-1"), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
