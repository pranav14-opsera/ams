import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useHealthWebSocket } from "./useHealthWebSocket";

const mockUseRealtimeUpdates = vi.fn();
vi.mock("@/hooks/useRealtimeUpdates", () => ({
  useRealtimeUpdates: (...args: unknown[]) => mockUseRealtimeUpdates(...args),
}));

describe("useHealthWebSocket", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("subscribes to the 'health' channel and passes through connectionState/latest", () => {
    mockUseRealtimeUpdates.mockReturnValue({ connectionState: "connected", latest: { summary: { totalAgents: 1 } } });

    const { result } = renderHook(() => useHealthWebSocket());

    expect(mockUseRealtimeUpdates).toHaveBeenCalledWith("health");
    expect(result.current.connectionState).toBe("connected");
    expect(result.current.latest).toEqual({ summary: { totalAgents: 1 } });
  });

  it("is not stale immediately after a fresh update arrives", () => {
    mockUseRealtimeUpdates.mockReturnValue({ connectionState: "connected", latest: { summary: { totalAgents: 1 } } });
    const { result } = renderHook(() => useHealthWebSocket());
    expect(result.current.isStale).toBe(false);
  });

  it("flags stale once 30 seconds pass with no newer update", () => {
    vi.useFakeTimers();
    mockUseRealtimeUpdates.mockReturnValue({ connectionState: "connected", latest: { summary: { totalAgents: 1 } } });
    const { result } = renderHook(() => useHealthWebSocket());

    void act(() => vi.advanceTimersByTime(30_000));
    expect(result.current.isStale).toBe(true);
  });

  it("resets staleness back to false once a newer update arrives", () => {
    vi.useFakeTimers();
    mockUseRealtimeUpdates.mockReturnValue({ connectionState: "connected", latest: { summary: { totalAgents: 1 } } });
    const { result, rerender } = renderHook(() => useHealthWebSocket());
    void act(() => vi.advanceTimersByTime(30_000));
    expect(result.current.isStale).toBe(true);

    mockUseRealtimeUpdates.mockReturnValue({ connectionState: "connected", latest: { summary: { totalAgents: 2 } } });
    rerender();
    expect(result.current.isStale).toBe(false);
  });

  it("with no data yet, isStale stays false (nothing to go stale)", () => {
    vi.useFakeTimers();
    mockUseRealtimeUpdates.mockReturnValue({ connectionState: "connecting", latest: undefined });
    const { result } = renderHook(() => useHealthWebSocket());

    void act(() => vi.advanceTimersByTime(60_000));
    expect(result.current.isStale).toBe(false);
  });
});
