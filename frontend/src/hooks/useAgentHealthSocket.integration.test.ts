import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAgentHealthSocket } from "./useAgentHealthSocket";
import { useAppStore } from "@/stores/app-store";
import { useRealtimeStore } from "@/stores/realtime-store";
import agentStatusUpdateFixture from "@/test/fixtures/websocket/agent-status-update.json";
import authSuccess from "@/test/fixtures/websocket/auth-success.json";
import { installMockWebSocket, MockWebSocket } from "@/test/utils/mock-websocket-server";
import type { ServerMessage } from "@/types/websocket";

async function connectAndAuth() {
  await waitFor(() => expect(MockWebSocket.instances.length).toBeGreaterThan(0));
  act(() => MockWebSocket.latest().emitServerMessage(authSuccess as unknown as ServerMessage));
}

/**
 * End-to-end (real WebSocket subscription lifecycle) coverage for
 * useAgentHealthSocket, going through the actual useRealtimeUpdates ->
 * useWebSocket chain rather than mocking useRealtimeUpdates — AC:
 * "Integration tests validate the WebSocket subscription lifecycle
 * (connect, receive update, disconnect)."
 */
describe("useAgentHealthSocket (integration, real WebSocket subscription lifecycle)", () => {
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

  it("subscribes to the /ws/health channel on connect", async () => {
    renderHook(() => useAgentHealthSocket());
    await connectAndAuth();
    await waitFor(() => expect(MockWebSocket.latest().sent).toContainEqual({ type: "subscribe", channel: "health" }));
  });

  it("receives a real agent_status_update message pushed on the health channel and merges it in by agentId", async () => {
    const { result } = renderHook(() => useAgentHealthSocket());
    await connectAndAuth();

    act(() => {
      MockWebSocket.latest().emitServerMessage(agentStatusUpdateFixture as unknown as ServerMessage);
    });

    await waitFor(() => expect(result.current.statusUpdates.size).toBe(1));
    const payload = agentStatusUpdateFixture.payload;
    expect(result.current.statusUpdates.get(payload.agentId)).toEqual({ status: payload.status, lastSeen: payload.lastSeen });
  });

  it("unsubscribes from the health channel on unmount (clean disconnect)", async () => {
    const { unmount } = renderHook(() => useAgentHealthSocket());
    await connectAndAuth();
    await waitFor(() => expect(MockWebSocket.latest().sent).toContainEqual({ type: "subscribe", channel: "health" }));

    unmount();
    expect(MockWebSocket.latest().sent).toContainEqual({ type: "unsubscribe", channel: "health" });
  });

  it("reflects a reconnecting connection state after an unexpected disconnect", async () => {
    const { result } = renderHook(() => useAgentHealthSocket());
    await connectAndAuth();
    await waitFor(() => expect(result.current.connectionState).toBe("connected"));

    act(() => MockWebSocket.latest().emitUnexpectedDisconnect());
    await waitFor(() => expect(result.current.connectionState).toBe("reconnecting"));
  });
});
