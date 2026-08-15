"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import type { RefObject } from "react";

const ESTIMATED_CARD_HEIGHT_PX = 140;
const OVERSCAN_COUNT = 5;

/**
 * AC: only visible viewport items rendered in the DOM. Returns the
 * virtualizer instance itself (not just getVirtualItems()/getTotalSize())
 * so the consuming grid component can also wire `measureElement` (dynamic
 * height measurement for AgentHealthCard's actual, variable rendered
 * height — the estimate only matters for the very first layout pass) and
 * `scrollToIndex` (keyboard Home/End navigation over virtualized rows).
 */
export function useVirtualizedAgentList(count: number, scrollElementRef: RefObject<HTMLElement | null>) {
  return useVirtualizer({
    count,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => ESTIMATED_CARD_HEIGHT_PX,
    overscan: OVERSCAN_COUNT,
  });
}
