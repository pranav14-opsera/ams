import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentRegistryQuery } from "./useAgentRegistryQuery";
import { useAppStore } from "@/stores/app-store";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function result(overrides: Record<string, unknown> = {}) {
  return { data: [], pagination: { page: 1, pageSize: 25, total: 0, totalPages: 0 }, ...overrides };
}

describe("useAgentRegistryQuery", () => {
  beforeEach(() => {
    useAppStore.setState({ auth: { userId: "u1", tenantId: "t1", roles: [], permissions: [], token: "jwt-abc" } });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("requests limit/offset translated from page/pageSize", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => result() });
    vi.stubGlobal("fetch", fetchMock);

    const { result: hookResult } = renderHook(() => useAgentRegistryQuery({}, { sortBy: "name", sortOrder: "asc" }, 3, 25), { wrapper });
    await waitFor(() => expect(hookResult.current.isSuccess).toBe(true));

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toContain("limit=25");
    expect(url).toContain("offset=50"); // page 3, pageSize 25 -> offset 50
    expect(url).toContain("sortBy=name");
    expect(url).toContain("sortOrder=asc");
  });

  it("sends comma-separated framework and lifecycleStatus filters", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => result() });
    vi.stubGlobal("fetch", fetchMock);

    const { result: hookResult } = renderHook(
      () => useAgentRegistryQuery({ framework: ["langchain", "crewai"], status: ["active", "paused"] }, { sortBy: "name", sortOrder: "asc" }, 1, 25),
      { wrapper },
    );
    await waitFor(() => expect(hookResult.current.isSuccess).toBe(true));

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toContain("framework=langchain%2Ccrewai");
    expect(url).toContain("lifecycleStatus=active%2Cpaused");
  });

  it("includes the Authorization header when a token is present", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => result() });
    vi.stubGlobal("fetch", fetchMock);

    const { result: hookResult } = renderHook(() => useAgentRegistryQuery({}, { sortBy: "name", sortOrder: "asc" }, 1, 25), { wrapper });
    await waitFor(() => expect(hookResult.current.isSuccess).toBe(true));

    const [, init] = fetchMock.mock.calls[0]!;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jwt-abc");
  });

  it("attaches the response status to a non-ok response's thrown error", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    const { result: hookResult } = renderHook(() => useAgentRegistryQuery({}, { sortBy: "name", sortOrder: "asc" }, 1, 25), { wrapper });
    await waitFor(() => expect(hookResult.current.isError).toBe(true));

    expect((hookResult.current.error as Error & { status?: number }).status).toBe(403);
  });
});
