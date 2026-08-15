import { renderHook } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { useVirtualizedAgentList } from "./useVirtualizedAgentList";

describe("useVirtualizedAgentList", () => {
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 800 });
  });

  it("maps a scroll position to a visible range far smaller than the full count", () => {
    const scrollElement = document.createElement("div");
    document.body.appendChild(scrollElement);
    const ref = { current: scrollElement };

    const { result } = renderHook(() => useVirtualizedAgentList(600, ref));
    const visible = result.current.getVirtualItems();

    expect(visible.length).toBeGreaterThan(0);
    expect(visible.length).toBeLessThan(600);
  });

  it("getTotalSize reflects the full item count's estimated total height, not just the visible slice", () => {
    const scrollElement = document.createElement("div");
    document.body.appendChild(scrollElement);
    const ref = { current: scrollElement };

    const { result } = renderHook(() => useVirtualizedAgentList(600, ref));
    // 600 items * 140px estimate = 84000, before any dynamic remeasurement.
    expect(result.current.getTotalSize()).toBe(600 * 140);
  });

  it("with zero items, there is nothing to virtualize", () => {
    const scrollElement = document.createElement("div");
    document.body.appendChild(scrollElement);
    const ref = { current: scrollElement };

    const { result } = renderHook(() => useVirtualizedAgentList(0, ref));
    expect(result.current.getVirtualItems()).toHaveLength(0);
    expect(result.current.getTotalSize()).toBe(0);
  });
});
