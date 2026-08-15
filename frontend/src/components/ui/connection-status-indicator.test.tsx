import { render, screen } from "@testing-library/react";
import { act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useRealtimeStore } from "@/stores/realtime-store";
import { ConnectionStatusIndicator } from "./connection-status-indicator";

function reset() {
  useRealtimeStore.setState({
    connectionState: "connecting",
    subscriptions: new Set(),
    reconnectAttempts: 0,
    lastConnectedAt: null,
    latestByChannel: new Map(),
  });
}

describe("ConnectionStatusIndicator", () => {
  it.each([
    ["connected", "Connected"],
    ["connecting", "Connecting"],
    ["reconnecting", "Reconnecting"],
    ["disconnected", "Disconnected"],
    ["error", "Connection error"],
  ] as const)("renders the correct label for state '%s'", (state, label) => {
    reset();
    act(() => useRealtimeStore.setState({ connectionState: state }));
    render(<ConnectionStatusIndicator />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("updates its aria-live region when the connection state changes", () => {
    reset();
    render(<ConnectionStatusIndicator />);
    expect(screen.getByText("Connecting")).toBeInTheDocument();

    act(() => useRealtimeStore.setState({ connectionState: "connected" }));
    expect(screen.getByText("Connected")).toBeInTheDocument();
  });

  it("includes the retry count in the tooltip once reconnect attempts have happened", () => {
    reset();
    act(() => useRealtimeStore.setState({ connectionState: "reconnecting", reconnectAttempts: 3 }));
    const { container } = render(<ConnectionStatusIndicator />);
    expect(container.querySelector("[title]")?.getAttribute("title")).toContain("Retry attempts: 3");
  });
});
