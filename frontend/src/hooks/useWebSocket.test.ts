import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/stores/app-store";
import { installMockWebSocket, MockWebSocket } from "@/test/utils/mock-websocket-server";
import authSuccess from "@/test/fixtures/websocket/auth-success.json";
import authFailure from "@/test/fixtures/websocket/auth-failure.json";
import type { ServerMessage } from "@/types/websocket";
import { useWebSocket } from "./useWebSocket";

describe("useWebSocket", () => {
  let restore: () => void;

  beforeEach(() => {
    restore = installMockWebSocket();
    useAppStore.setState({ auth: { userId: "u1", tenantId: "t1", roles: [], permissions: [], token: "jwt-abc" } });
  });

  afterEach(() => {
    restore();
    vi.useRealTimers();
  });

  it("connects and sends an auth message with the JWT token from the store", async () => {
    renderHook(() => useWebSocket());
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    const ws = MockWebSocket.latest();
    await waitFor(() => expect(ws.sent).toContainEqual({ type: "auth", token: "jwt-abc" }));
  });

  it("transitions to 'connected' once the server acks auth", async () => {
    const { result } = renderHook(() => useWebSocket());
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    MockWebSocket.latest().emitServerMessage(authSuccess as unknown as ServerMessage);
    await waitFor(() => expect(result.current.state).toBe("connected"));
  });

  it("transitions to 'error' if the server rejects auth", async () => {
    const { result } = renderHook(() => useWebSocket());
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    MockWebSocket.latest().emitServerMessage(authFailure as unknown as ServerMessage);
    await waitFor(() => expect(result.current.state).toBe("error"));
  });

  it("delivers non-protocol messages (e.g. data) via onMessage", async () => {
    const onMessage = vi.fn();
    renderHook(() => useWebSocket({ onMessage }));
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(1));
    MockWebSocket.latest().emitServerMessage(authSuccess as unknown as ServerMessage);

    const dataMessage = { type: "data", channel: "alerts", payload: { x: 1 }, timestamp: "2026-01-01T00:00:00.000Z" } as const;
    MockWebSocket.latest().emitServerMessage(dataMessage as unknown as ServerMessage);
    await waitFor(() => expect(onMessage).toHaveBeenCalledWith(dataMessage));
  });

  it("reconnects with exponential backoff (1s, 2s, 4s, ...) after an unexpected disconnect", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() => useWebSocket());
    await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(1));

    act(() => MockWebSocket.latest().emitUnexpectedDisconnect());
    expect(result.current.state).toBe("reconnecting");

    await act(() => vi.advanceTimersByTimeAsync(999));
    expect(MockWebSocket.instances.length).toBe(1); // not yet

    await act(() => vi.advanceTimersByTimeAsync(2));
    await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(2)); // 1st retry at ~1s
  });

  it("gives up and enters a permanent 'error' state after 10 retry attempts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderHook(() => useWebSocket());

    // Initial connection (#1) + 10 retries = 11 disconnects total before the
    // 11th disconnect's own scheduleReconnect check finds the limit reached.
    for (let attempt = 0; attempt < 11; attempt++) {
      await vi.waitFor(() => expect(MockWebSocket.instances.length).toBe(attempt + 1));
      act(() => MockWebSocket.latest().emitUnexpectedDisconnect());
      const delay = Math.min(1000 * 2 ** attempt, 30_000);
      await act(() => vi.advanceTimersByTimeAsync(delay + 5));
    }

    expect(result.current.state).toBe("error");
  }, 10_000);

  it("a clean (intentional) disconnect does NOT trigger reconnection", async () => {
    const { result } = renderHook(() => useWebSocket());
    await waitFor(() => expect(MockWebSocket.instances.length).toBe(1));

    result.current.disconnect();
    await waitFor(() => expect(result.current.state).toBe("disconnected"));

    expect(MockWebSocket.instances.length).toBe(1); // no reconnect attempt
  });
});
