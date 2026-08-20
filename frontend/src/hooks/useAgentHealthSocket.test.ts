import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAgentHealthSocket } from "./useAgentHealthSocket";

let capturedOnUpdate: ((payload: unknown) => void) | undefined;
const mockUseRealtimeUpdates = vi.fn();
vi.mock("@/hooks/useRealtimeUpdates", () => ({
  useRealtimeUpdates: (channel: string, onUpdate: (payload: unknown) => void) => {
    capturedOnUpdate = onUpdate;
    return mockUseRealtimeUpdates(channel, onUpdate);
  },
}));

describe("useAgentHealthSocket", () => {
  afterEach(() => {
    vi.clearAllMocks();
    capturedOnUpdate = undefined;
  });

  it("subscribes to the 'health' channel (reusing the existing WebSocket plumbing, not a new one)", () => {
    mockUseRealtimeUpdates.mockReturnValue({ connectionState: "connected", latest: undefined });
    renderHook(() => useAgentHealthSocket());
    expect(mockUseRealtimeUpdates).toHaveBeenCalledWith("health", expect.any(Function));
  });

  it("stores an agent_status_update message keyed by agentId", () => {
    mockUseRealtimeUpdates.mockReturnValue({ connectionState: "connected", latest: undefined });
    const { result } = renderHook(() => useAgentHealthSocket());

    act(() => {
      capturedOnUpdate?.({ type: "agent_status_update", agentId: "agent-1", status: "active", lastSeen: "2026-08-20T12:00:00.000Z" });
    });

    expect(result.current.statusUpdates.get("agent-1")).toEqual({ status: "active", lastSeen: "2026-08-20T12:00:00.000Z" });
  });

  it("ignores a message that is not shape-tagged as agent_status_update (e.g. a fleet health snapshot on the same channel)", () => {
    mockUseRealtimeUpdates.mockReturnValue({ connectionState: "connected", latest: undefined });
    const { result } = renderHook(() => useAgentHealthSocket());

    act(() => {
      capturedOnUpdate?.({ summary: { totalAgents: 10 }, agents: [] });
    });

    expect(result.current.statusUpdates.size).toBe(0);
  });

  it("ignores malformed/non-object payloads without crashing", () => {
    mockUseRealtimeUpdates.mockReturnValue({ connectionState: "connected", latest: undefined });
    const { result } = renderHook(() => useAgentHealthSocket());

    act(() => {
      capturedOnUpdate?.(null);
      capturedOnUpdate?.("not an object");
      capturedOnUpdate?.(42);
    });

    expect(result.current.statusUpdates.size).toBe(0);
  });

  it("keeps prior agents' updates when a later update arrives for a different agent", () => {
    mockUseRealtimeUpdates.mockReturnValue({ connectionState: "connected", latest: undefined });
    const { result } = renderHook(() => useAgentHealthSocket());

    act(() => {
      capturedOnUpdate?.({ type: "agent_status_update", agentId: "agent-1", status: "active", lastSeen: "2026-08-20T12:00:00.000Z" });
      capturedOnUpdate?.({ type: "agent_status_update", agentId: "agent-2", status: "paused", lastSeen: "2026-08-20T12:00:01.000Z" });
    });

    expect(result.current.statusUpdates.size).toBe(2);
    expect(result.current.statusUpdates.get("agent-1")?.status).toBe("active");
    expect(result.current.statusUpdates.get("agent-2")?.status).toBe("paused");
  });

  it("passes through the connection state from useRealtimeUpdates", () => {
    mockUseRealtimeUpdates.mockReturnValue({ connectionState: "reconnecting", latest: undefined });
    const { result } = renderHook(() => useAgentHealthSocket());
    expect(result.current.connectionState).toBe("reconnecting");
  });
});
