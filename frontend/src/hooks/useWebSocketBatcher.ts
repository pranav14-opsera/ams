"use client";

import { useCallback, useEffect, useRef } from "react";

const BATCH_INTERVAL_MS = 100;

/**
 * AC: "incoming messages are buffered and delivered in batches every
 * 100ms using requestAnimationFrame to prevent excessive React
 * re-renders during high-frequency updates." A setInterval(100ms) alone
 * would fire even in a background/inactive tab (wasted work, and out of
 * sync with the browser's own paint cycle); requestAnimationFrame only
 * runs when the tab can actually paint, and checking elapsed time inside
 * it (rather than flushing on every single frame) is what gets the
 * ~100ms cadence instead of ~16ms.
 */
export function useWebSocketBatcher<T>(onBatch: (batch: T[]) => void) {
  const queueRef = useRef<T[]>([]);
  const lastFlushRef = useRef(0);
  const rafIdRef = useRef<number | null>(null);
  const onBatchRef = useRef(onBatch);
  useEffect(() => {
    onBatchRef.current = onBatch;
  }, [onBatch]);

  useEffect(() => {
    function tick(now: number) {
      if (now - lastFlushRef.current >= BATCH_INTERVAL_MS) {
        lastFlushRef.current = now;
        if (queueRef.current.length > 0) {
          const batch = queueRef.current;
          queueRef.current = [];
          onBatchRef.current(batch);
        }
      }
      rafIdRef.current = requestAnimationFrame(tick);
    }

    rafIdRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafIdRef.current !== null) cancelAnimationFrame(rafIdRef.current);
    };
  }, []);

  const enqueue = useCallback((item: T) => {
    queueRef.current.push(item);
  }, []);

  return { enqueue };
}
