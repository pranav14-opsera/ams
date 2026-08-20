import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/stores/app-store";
import { CONNECTION_VALIDATION_TIMEOUT_MS, useConnectionValidationPolling } from "./useConnectionValidationPolling";

function agentResponse(status: "pending" | "success" | "failed", overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    name: "Support Bot",
    framework: "generic_rest",
    lifecycleStatus: status === "success" ? "active" : "connecting",
    team: { id: "team-1", name: "Platform Team" },
    connectionValidation: { status, message: status === "failed" ? "Could not reach endpoint." : null, completedAt: status === "pending" ? null : "2026-08-20T12:00:00.000Z" },
    ...overrides,
  };
}

describe("useConnectionValidationPolling", () => {
  beforeEach(() => {
    useAppStore.setState({ auth: { userId: "u1", tenantId: "t1", roles: [], permissions: [], token: "jwt" } });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("starts idle when no agentId is supplied", () => {
    const { result } = renderHook(() => useConnectionValidationPolling(null));
    expect(result.current.phase).toBe("idle");
  });

  it("transitions idle -> validating -> success once the poll reports success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => agentResponse("success") });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useConnectionValidationPolling("agent-1"));
    expect(result.current.phase).toBe("validating");

    await vi.waitFor(() => expect(result.current.phase).toBe("success"));
    expect(result.current.agent?.lifecycleStatus).toBe("active");
  });

  it("transitions to error with the server-provided message when validation fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => agentResponse("failed") });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useConnectionValidationPolling("agent-1"));
    await vi.waitFor(() => expect(result.current.phase).toBe("error"));
    expect(result.current.errorMessage).toBe("Could not reach endpoint.");
  });

  it("transitions to timeout after the 60-second budget elapses without a terminal outcome", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => agentResponse("pending") });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useConnectionValidationPolling("agent-1"));
    expect(result.current.phase).toBe("validating");

    await vi.advanceTimersByTimeAsync(CONNECTION_VALIDATION_TIMEOUT_MS + 5_000);
    expect(result.current.phase).toBe("timeout");
  });

  it("retry() resets to idle/validating and starts a fresh polling loop", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => agentResponse("failed") });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useConnectionValidationPolling("agent-1"));
    await vi.waitFor(() => expect(result.current.phase).toBe("error"));

    fetchMock.mockResolvedValue({ ok: true, json: async () => agentResponse("success") });
    result.current.retry();

    await vi.waitFor(() => expect(result.current.phase).toBe("success"));
  });
});
