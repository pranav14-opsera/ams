import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useHealthWebSocket } from "./useHealthWebSocket";

let capturedOnUpdate: ((payload: unknown) => void) | undefined;
const mockUseRealtimeUpdates = vi.fn();
vi.mock("@/hooks/useRealtimeUpdates", () => ({
  useRealtimeUpdates: (...args: unknown[]) => mockUseRealtimeUpdates(...args),
}));

function mockConnectionState(connectionState: string) {
  mockUseRealtimeUpdates.mockImplementation((_channel: string, onUpdate: (payload: unknown) => void) => {
    capturedOnUpdate = onUpdate;
    return { connectionState, latest: undefined };
  });
}

describe("useHealthWebSocket", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    capturedOnUpdate = undefined;
  });

  it("subscribes to the 'health' channel and passes through connectionState", () => {
    mockConnectionState("connected");
    const { result } = renderHook(() => useHealthWebSocket());

    expect(mockUseRealtimeUpdates).toHaveBeenCalledWith("health", expect.any(Function));
    expect(result.current.connectionState).toBe("connected");
  });

  it("a genuine fleet-health snapshot (no type discriminant) becomes latest", () => {
    mockConnectionState("connected");
    const { result } = renderHook(() => useHealthWebSocket());

    act(() => capturedOnUpdate!({ summary: { totalAgents: 1 } }));
    expect(result.current.latest).toEqual({ summary: { totalAgents: 1 } });
  });

  it("WO-079 regression: an agent_status_update message sharing the same 'health' channel is ignored, never overwrites latest with a malformed snapshot", () => {
    mockConnectionState("connected");
    const { result } = renderHook(() => useHealthWebSocket());

    act(() => capturedOnUpdate!({ summary: { totalAgents: 1 } }));
    act(() => capturedOnUpdate!({ type: "agent_status_update", agentId: "agent-1", status: "paused", lastSeen: "2026-08-20T00:00:00.000Z" }));

    expect(result.current.latest).toEqual({ summary: { totalAgents: 1 } });
  });

  it("is not stale immediately after a fresh update arrives", () => {
    mockConnectionState("connected");
    const { result } = renderHook(() => useHealthWebSocket());
    act(() => capturedOnUpdate!({ summary: { totalAgents: 1 } }));
    expect(result.current.isStale).toBe(false);
  });

  it("flags stale once 30 seconds pass with no newer update", () => {
    vi.useFakeTimers();
    mockConnectionState("connected");
    const { result } = renderHook(() => useHealthWebSocket());
    act(() => capturedOnUpdate!({ summary: { totalAgents: 1 } }));

    void act(() => vi.advanceTimersByTime(30_000));
    expect(result.current.isStale).toBe(true);
  });

  it("resets staleness back to false once a newer snapshot arrives", () => {
    vi.useFakeTimers();
    mockConnectionState("connected");
    const { result } = renderHook(() => useHealthWebSocket());
    act(() => capturedOnUpdate!({ summary: { totalAgents: 1 } }));
    void act(() => vi.advanceTimersByTime(30_000));
    expect(result.current.isStale).toBe(true);

    act(() => capturedOnUpdate!({ summary: { totalAgents: 2 } }));
    expect(result.current.isStale).toBe(false);
  });

  it("with no data yet, isStale stays false (nothing to go stale)", () => {
    vi.useFakeTimers();
    mockConnectionState("connecting");
    const { result } = renderHook(() => useHealthWebSocket());

    void act(() => vi.advanceTimersByTime(60_000));
    expect(result.current.isStale).toBe(false);
  });
});
