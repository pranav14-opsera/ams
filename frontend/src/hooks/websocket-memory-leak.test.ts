import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "@/stores/app-store";
import { installMockWebSocket, MockWebSocket } from "@/test/utils/mock-websocket-server";
import { useRealtimeUpdates } from "./useRealtimeUpdates";
import { useWebSocket } from "./useWebSocket";

describe("memory leak: mounting/unmounting useWebSocket and useRealtimeUpdates repeatedly", () => {
  let restore: () => void;

  beforeEach(() => {
    restore = installMockWebSocket();
    useAppStore.setState({ auth: { userId: "u1", tenantId: "t1", roles: [], permissions: [], token: "jwt-abc" } });
  });

  afterEach(() => restore());

  it("useWebSocket: 100 mount/unmount cycles leave no lingering open connections", async () => {
    for (let i = 0; i < 100; i++) {
      const { unmount } = renderHook(() => useWebSocket());
      await waitFor(() => expect(MockWebSocket.instances.length).toBe(i + 1));
      unmount();
    }

    const stillOpen = MockWebSocket.instances.filter((ws) => ws.readyState === MockWebSocket.OPEN || ws.readyState === MockWebSocket.CONNECTING);
    expect(stillOpen).toHaveLength(0);
  }, 20_000);

  it("useRealtimeUpdates: 100 mount/unmount cycles leave no lingering open connections", async () => {
    for (let i = 0; i < 100; i++) {
      const { unmount } = renderHook(() => useRealtimeUpdates("agent-health"));
      await waitFor(() => expect(MockWebSocket.instances.length).toBe(i + 1));
      unmount();
    }

    const stillOpen = MockWebSocket.instances.filter((ws) => ws.readyState === MockWebSocket.OPEN || ws.readyState === MockWebSocket.CONNECTING);
    expect(stillOpen).toHaveLength(0);
  }, 20_000);
});
