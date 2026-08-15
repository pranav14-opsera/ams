import type { ServerMessage } from "@/types/websocket";

/**
 * A fake `WebSocket` implementation with programmable server-side
 * behavior, installed as `global.WebSocket` for the duration of a test.
 * Real browser WebSocket semantics this mock reproduces: readyState
 * transitions (CONNECTING -> OPEN -> CLOSING -> CLOSED), async `onopen`
 * (a real socket never opens synchronously), and JSON-string message
 * framing (`event.data` is always a string, matching a real WS frame).
 */
export class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  readonly sent: unknown[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    // A real WebSocket never opens on the same tick it was constructed.
    queueMicrotask(() => {
      if (this.readyState === MockWebSocket.CONNECTING) {
        this.readyState = MockWebSocket.OPEN;
        this.onopen?.(new Event("open"));
      }
    });
  }

  send(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error("MockWebSocket: cannot send while not OPEN");
    }
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { wasClean: true }));
  }

  /** Test-side: push a server->client message down this connection. */
  emitServerMessage(message: ServerMessage): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
  }

  /** Test-side: simulate an unexpected server-initiated disconnect (not a clean client close). */
  emitUnexpectedDisconnect(): void {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { wasClean: false }));
  }

  static instances: MockWebSocket[] = [];
  static reset(): void {
    MockWebSocket.instances = [];
  }
  static latest(): MockWebSocket {
    const last = MockWebSocket.instances[MockWebSocket.instances.length - 1];
    if (!last) throw new Error("MockWebSocket: no instances constructed yet");
    return last;
  }
}

/** Installs MockWebSocket as global.WebSocket for a test; returns a restore function. */
export function installMockWebSocket(): () => void {
  const original = globalThis.WebSocket;
  // @ts-expect-error -- intentionally substituting the whole constructor for tests.
  globalThis.WebSocket = MockWebSocket;
  MockWebSocket.reset();
  return () => {
    globalThis.WebSocket = original;
  };
}
