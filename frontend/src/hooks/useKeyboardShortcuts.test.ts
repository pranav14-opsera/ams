import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useKeyboardShortcuts, type ShortcutMap } from "./useKeyboardShortcuts";

function fireKey(init: Partial<KeyboardEventInit> & { key: string }, target: EventTarget = window) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe("useKeyboardShortcuts", () => {
  it("calls the registered handler for a matching combo", () => {
    const handler = vi.fn();
    const shortcuts: ShortcutMap = new Map([["ctrl+k", handler]]);
    renderHook(() => useKeyboardShortcuts(shortcuts));

    fireKey({ key: "k", ctrlKey: true });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not call the handler for a non-matching combo", () => {
    const handler = vi.fn();
    const shortcuts: ShortcutMap = new Map([["ctrl+k", handler]]);
    renderHook(() => useKeyboardShortcuts(shortcuts));

    fireKey({ key: "k" }); // no ctrl
    expect(handler).not.toHaveBeenCalled();
  });

  it("suppresses handling while an input element is focused", () => {
    const handler = vi.fn();
    const shortcuts: ShortcutMap = new Map([["k", handler]]);
    renderHook(() => useKeyboardShortcuts(shortcuts));

    const input = document.createElement("input");
    document.body.appendChild(input);
    fireKey({ key: "k" }, input);

    expect(handler).not.toHaveBeenCalled();
    input.remove();
  });

  it("never fires for a reserved browser combo like ctrl+w", () => {
    const handler = vi.fn();
    const shortcuts: ShortcutMap = new Map([["ctrl+w", handler]]);
    renderHook(() => useKeyboardShortcuts(shortcuts));

    fireKey({ key: "w", ctrlKey: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it("does nothing when disabled", () => {
    const handler = vi.fn();
    const shortcuts: ShortcutMap = new Map([["k", handler]]);
    renderHook(() => useKeyboardShortcuts(shortcuts, false));

    fireKey({ key: "k" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("cleans up its listener on unmount", () => {
    const handler = vi.fn();
    const shortcuts: ShortcutMap = new Map([["k", handler]]);
    const { unmount } = renderHook(() => useKeyboardShortcuts(shortcuts));

    unmount();
    fireKey({ key: "k" });
    expect(handler).not.toHaveBeenCalled();
  });
});
