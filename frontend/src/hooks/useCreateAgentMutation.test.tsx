import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/stores/app-store";
import { CreateAgentError, useCreateAgentMutation, useRetryValidationMutation } from "./useCreateAgentMutation";
import type { CreateAgentRequest } from "@/types/dashboard";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const REQUEST: CreateAgentRequest = { name: "Support Bot", framework: "generic_rest", teamId: "team-1", connectionConfig: { baseUrl: "https://x.example.com" } };

describe("useCreateAgentMutation", () => {
  beforeEach(() => {
    useAppStore.setState({ auth: { userId: "u1", tenantId: "t1", roles: ["platform_admin"], permissions: [], token: "jwt-abc" } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs the wizard's request body and resolves with the created agent", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ id: "agent-1", name: "Support Bot", framework: "generic_rest", status: "connecting", teamId: "team-1", createdAt: "2026-08-20T00:00:00Z" }) });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCreateAgentMutation(), { wrapper });
    const created = await result.current.mutateAsync(REQUEST);

    expect(created.status).toBe("connecting");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/api/v1/agents");
    expect(JSON.parse(init.body as string)).toEqual(REQUEST);
  });

  it("throws a CreateAgentError carrying the status and structured body on a 409", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ error: "CONFLICT", message: 'An agent named "Support Bot" already exists.' }) });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCreateAgentMutation(), { wrapper });
    try {
      await result.current.mutateAsync(REQUEST);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CreateAgentError);
      expect((err as CreateAgentError).status).toBe(409);
      expect((err as CreateAgentError).message).toMatch(/already exists/);
    }
  });

  it("maps 400 field-level details onto the CreateAgentError body", async () => {
    const details = [{ field: "connectionConfig.baseUrl", message: "must be a valid URL" }];
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: "VALIDATION_ERROR", message: "Invalid connection configuration", details }) });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useCreateAgentMutation(), { wrapper });
    await expect(result.current.mutateAsync(REQUEST)).rejects.toMatchObject({ status: 400, body: { details } });
  });
});

describe("useRetryValidationMutation", () => {
  beforeEach(() => {
    useAppStore.setState({ auth: { userId: "u1", tenantId: "t1", roles: ["platform_admin"], permissions: [], token: "jwt-abc" } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs to the agent's own retry-validation route", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useRetryValidationMutation(), { wrapper });
    await result.current.mutateAsync("agent-1");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain("/api/v1/agents/agent-1/retry-validation");
    expect(init.method).toBe("POST");
  });
});
