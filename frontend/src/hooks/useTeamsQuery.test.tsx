import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/stores/app-store";
import { useCreateTeamMutation, useTeamsQuery } from "./useTeamsQuery";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useTeamsQuery", () => {
  beforeEach(() => {
    useAppStore.setState({ auth: { userId: "u1", tenantId: "t1", roles: ["platform_admin"], permissions: [], token: "jwt-abc" } });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("fetches GET /api/v1/teams with the Authorization header", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ teams: [{ id: "t1", name: "Platform Team", memberCount: 5 }] }) });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useTeamsQuery(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual([{ id: "t1", name: "Platform Team", memberCount: 5 }]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/api/v1/teams");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jwt-abc");
  });

  it("attaches the response status to a non-ok response's thrown error", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useTeamsQuery(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as Error & { status?: number }).status).toBe(403);
  });
});

describe("useCreateTeamMutation", () => {
  beforeEach(() => {
    useAppStore.setState({ auth: { userId: "u1", tenantId: "t1", roles: ["platform_admin"], permissions: [], token: "jwt-abc" } });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("POSTs the new team name and returns the created team", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ id: "t2", name: "New Team", memberCount: 0 }) });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCreateTeamMutation(), { wrapper });
    const created = await result.current.mutateAsync("New Team");

    expect(created).toEqual({ id: "t2", name: "New Team", memberCount: 0 });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ name: "New Team" });
  });

  it("surfaces the server's error message on a duplicate team name", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ message: 'A team named "New Team" already exists for this tenant.' }) });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCreateTeamMutation(), { wrapper });
    await expect(result.current.mutateAsync("New Team")).rejects.toThrow(/already exists/);
  });
});
