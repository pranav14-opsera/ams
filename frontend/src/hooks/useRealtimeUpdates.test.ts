import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "@/stores/app-store";
import { useRealtimeStore } from "@/stores/realtime-store";
import { installMockWebSocket, MockWebSocket } from "@/test/utils/mock-websocket-server";
import authSuccess from "@/test/fixtures/websocket/auth-success.json";
import type { ServerMessage } from "@/types/websocket";
import { useRealtimeUpdates } from "./useRealtimeUpdates";

async function connectAndAuth() {
  await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0));
  act(() => MockWebSocket.latest().emitServerMessage(authSuccess as unknown as ServerMessage));
}

describe("useRealtimeUpdates", () => {
  let restore: () => void;

  beforeEach(() => {
    restore = installMockWebSocket();
    useAppStore.setState({ auth: { userId: "u1", tenantId: "t1", roles: [], permissions: [], token: "jwt-abc" } });
    useRealtimeStore.setState({
      connectionState: "connecting",
      subscriptions: new Set(),
      reconnectAttempts: 0,
      lastConnectedAt: null,
      latestByChannel: new Map(),
    });
  });

  afterEach(() => restore());

  it("sends a subscribe message for its channel once connected", async () => {
    renderHook(() => useRealtimeUpdates("agent-health"));
    await connectAndAuth();
    await waitFor(() => expect(MockWebSocket.latest().sent).toContainEqual({ type: "subscribe", channel: "agent-health" }));
  });

  it("sends an unsubscribe message on unmount", async () => {
    const { unmount } = renderHook(() => useRealtimeUpdates("agent-health"));
    await connectAndAuth();
    await waitFor(() => expect(MockWebSocket.latest().sent).toContainEqual({ type: "subscribe", channel: "agent-health" }));

    unmount();
    expect(MockWebSocket.latest().sent).toContainEqual({ type: "unsubscribe", channel: "agent-health" });
  });

  it("only delivers messages for its own channel (channel-specific filtering)", async () => {
    const onUpdate = vi.fn();
    renderHook(() => useRealtimeUpdates("agent-health", onUpdate));
    await connectAndAuth();

    act(() => {
      MockWebSocket.latest().emitServerMessage({
        type: "data",
        channel: "credit-balance",
        payload: { balance: 100 },
        timestamp: "2026-01-01T00:00:00.000Z",
      } as unknown as ServerMessage);
    });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(onUpdate).not.toHaveBeenCalled();

    act(() => {
      MockWebSocket.latest().emitServerMessage({
        type: "data",
        channel: "agent-health",
        payload: { status: "healthy" },
        timestamp: "2026-01-01T00:00:00.000Z",
      } as unknown as ServerMessage);
    });
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ status: "healthy" }));
  });

  it("batches 10 rapid messages into a single delivery", async () => {
    const onUpdate = vi.fn();
    renderHook(() => useRealtimeUpdates("agent-health", onUpdate));
    await connectAndAuth();

    act(() => {
      for (let i = 0; i < 10; i++) {
        MockWebSocket.latest().emitServerMessage({
          type: "data",
          channel: "agent-health",
          payload: { seq: i },
          timestamp: "2026-01-01T00:00:00.000Z",
        } as unknown as ServerMessage);
      }
    });

    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate).toHaveBeenCalledWith({ seq: 9 }); // only the LAST of the batch
  });
});
