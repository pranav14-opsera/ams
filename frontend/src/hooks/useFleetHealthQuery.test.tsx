import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFleetHealthQuery } from "./useFleetHealthQuery";
import { useAppStore } from "@/stores/app-store";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useFleetHealthQuery", () => {
  beforeEach(() => {
    useAppStore.setState({ auth: { userId: "u1", tenantId: "t1", roles: [], permissions: [], token: "jwt-abc" } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches the fleet health endpoint with a Bearer token and no query params when no filters are set", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ summary: {}, agents: [], total: 0, limit: 50, offset: 0, servedFromCache: false }) });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useFleetHealthQuery({}), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toMatch(/\/api\/v1\/agents\/health$/);
    expect(init.headers.Authorization).toBe("Bearer jwt-abc");
  });

  it("serializes filters as query parameters", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ summary: {}, agents: [], total: 0, limit: 50, offset: 0, servedFromCache: false }) });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useFleetHealthQuery({ framework: "crewai", status: "error" }), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toContain("framework=crewai");
    expect(url).toContain("status=error");
  });

  it("throws (surfaces as query error) on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));

    const { result } = renderHook(() => useFleetHealthQuery({}), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
