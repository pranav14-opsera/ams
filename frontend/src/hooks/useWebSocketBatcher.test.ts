import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useWebSocketBatcher } from "./useWebSocketBatcher";

function advanceFrames(count: number, stepMs = 20) {
  let now = 0;
  for (let i = 0; i < count; i++) {
    now += stepMs;
    void act(() => vi.advanceTimersByTime(stepMs));
  }
  return now;
}

describe("useWebSocketBatcher", () => {
  it("delivers nothing if the queue is empty", () => {
    vi.useFakeTimers();
    const onBatch = vi.fn();
    renderHook(() => useWebSocketBatcher(onBatch));
    advanceFrames(20);
    expect(onBatch).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("delivers 10 rapidly-enqueued items as a single batch within ~100-200ms", () => {
    vi.useFakeTimers();
    const onBatch = vi.fn();
    const { result } = renderHook(() => useWebSocketBatcher<number>(onBatch));

    act(() => {
      for (let i = 0; i < 10; i++) result.current.enqueue(i);
    });

    advanceFrames(10, 20); // ~200ms of frames at 20ms/frame
    expect(onBatch).toHaveBeenCalledTimes(1);
    expect(onBatch).toHaveBeenCalledWith([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    vi.useRealTimers();
  });

  it("stress: 1000 messages enqueued within 1 second deliver no more than ~10 batches", () => {
    vi.useFakeTimers();
    const onBatch = vi.fn();
    const { result } = renderHook(() => useWebSocketBatcher<number>(onBatch));

    // Simulate 1000 messages arriving spread across 1 second (1 per ms),
    // interleaved with frame advances so the batcher actually gets a
    // chance to flush mid-stream, the same way real incoming WS traffic would.
    for (let ms = 0; ms < 1000; ms++) {
      act(() => {
        result.current.enqueue(ms);
        vi.advanceTimersByTime(1);
      });
    }
    advanceFrames(10, 20); // flush whatever's left in the final partial batch

    expect(onBatch.mock.calls.length).toBeLessThanOrEqual(15); // ~10 +/- rounding, plus the trailing flush
    const delivered = onBatch.mock.calls.flatMap((call) => call[0] as number[]);
    expect(new Set(delivered).size).toBe(1000); // every message eventually delivered, none dropped
    vi.useRealTimers();
  });

  it("cleans up its rAF loop on unmount (no further batches after unmount)", () => {
    vi.useFakeTimers();
    const onBatch = vi.fn();
    const { result, unmount } = renderHook(() => useWebSocketBatcher<number>(onBatch));

    act(() => result.current.enqueue(1));
    unmount();
    advanceFrames(20);
    expect(onBatch).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
