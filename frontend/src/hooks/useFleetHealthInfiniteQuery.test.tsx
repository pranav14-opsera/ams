import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFleetHealthInfiniteQuery } from "./useFleetHealthInfiniteQuery";
import { useAppStore } from "@/stores/app-store";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function page(agents: unknown[], total: number) {
  return { summary: {}, agents, total, limit: 100, offset: 0, servedFromCache: false };
}

describe("useFleetHealthInfiniteQuery", () => {
  beforeEach(() => {
    useAppStore.setState({ auth: { userId: "u1", tenantId: "t1", roles: [], permissions: [], token: "jwt-abc" } });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("fetches page 1 with offset=0 on mount", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => page(new Array(100).fill({}), 250) });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useFleetHealthInfiniteQuery({}), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toContain("offset=0");
    expect(url).toContain("limit=100");
  });

  it("hasNextPage is true when fewer agents have loaded than the reported total", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => page(new Array(100).fill({}), 250) });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useFleetHealthInfiniteQuery({}), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(true);
  });

  it("fetchNextPage requests the next offset", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => page(new Array(100).fill({}), 250) });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useFleetHealthInfiniteQuery({}), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    await result.current.fetchNextPage();
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2));

    const [secondUrl] = fetchMock.mock.calls[1]!;
    expect(secondUrl).toContain("offset=100");
  });

  it("hasNextPage becomes false once every agent has been loaded", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => page(new Array(50).fill({}), 50) });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useFleetHealthInfiniteQuery({}), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(false);
  });
});
