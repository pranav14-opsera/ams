"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AgentHealthCard } from "@/components/dashboard/agent-health-card";
import { useVirtualizedAgentList } from "@/hooks/useVirtualizedAgentList";
import type { AgentHealthViewModel } from "@/types/dashboard";

const LOAD_MORE_THRESHOLD_PCT = 0.8; // AC: prefetch next page once scroll reaches 80% of viewport
const VIEWPORT_HEIGHT_PX = 600;

export interface VirtualizedAgentGridProps {
  agents: AgentHealthViewModel[];
  onSelect?: (agentId: string) => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
}

/**
 * AC: only visible viewport items in the DOM (verified by DOM node
 * count), aria-rowcount/aria-rowindex for assistive tech, and keyboard
 * navigation (Tab/Arrow/Home/End) over virtualized content — a screen
 * reader or keyboard user must be able to reach every row even though
 * most of them don't exist in the DOM at any given moment.
 */
export function VirtualizedAgentGrid({ agents, onSelect, onLoadMore, hasMore = false }: VirtualizedAgentGridProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const virtualizer = useVirtualizedAgentList(agents.length, scrollRef);

  const focusRow = useCallback((index: number) => {
    virtualizer.scrollToIndex(index, { align: "auto" });
    setFocusedIndex(index);
  }, [virtualizer]);

  useEffect(() => {
    if (focusedIndex === null) return;
    // The virtualizer needs a render pass to mount a newly-scrolled-to row before it can be focused.
    const raf = requestAnimationFrame(() => {
      scrollRef.current?.querySelector<HTMLElement>(`[data-index="${focusedIndex}"] [role="button"]`)?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [focusedIndex]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (agents.length === 0) return;
    const current = focusedIndex ?? 0;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusRow(Math.min(agents.length - 1, current + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusRow(Math.max(0, current - 1));
    } else if (event.key === "Home") {
      event.preventDefault();
      focusRow(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusRow(agents.length - 1);
    }
  };

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el || !onLoadMore || !hasMore) return;
    const scrolledPct = (el.scrollTop + el.clientHeight) / el.scrollHeight;
    if (scrolledPct >= LOAD_MORE_THRESHOLD_PCT) onLoadMore();
  };

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      onKeyDown={handleKeyDown}
      role="grid"
      tabIndex={0}
      aria-label="Agent health list"
      aria-rowcount={agents.length}
      style={{ height: VIEWPORT_HEIGHT_PX, overflow: "auto", position: "relative" }}
    >
      <div style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const agent = agents[virtualRow.index];
          if (!agent) return null;
          return (
            <div
              key={agent.id}
              ref={virtualizer.measureElement}
              data-index={virtualRow.index}
              role="row"
              aria-rowindex={virtualRow.index + 1}
              style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtualRow.start}px)` }}
            >
              <div role="gridcell">
                <AgentHealthCard agent={agent} onSelect={onSelect} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
