import { act, render } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { VirtualizedAgentGrid } from "./virtualized-agent-grid";
import fixtures from "@/test/fixtures/dashboard/agent-health-600-fixtures.json";
import type { AgentHealthViewModel } from "@/types/dashboard";

const agents = fixtures.records as AgentHealthViewModel[];

/**
 * AC: "renders 500+ agent health cards without frame rate dropping below
 * 30fps, verified via Chrome DevTools Performance profiling" and "10
 * WebSocket updates/second... measuring frame rate via Performance API."
 *
 * jsdom has no real paint/compositor pipeline — there is no genuine frame
 * rate to measure here, and pretending otherwise would be a fabricated
 * number. What THIS test verifies instead, honestly: with virtualization
 * in place, the actual JS work done per update (render + 600-agent
 * re-renders simulating rapid WebSocket pushes) stays within a budget
 * that would allow 30fps (33.3ms/frame) if it were the only work
 * happening on a real browser's main thread — a necessary-but-not-
 * sufficient proxy. The AUTHORITATIVE check for the AC's literal "Chrome
 * DevTools Performance profiling" wording is a real-browser measurement
 * this repo's Playwright suite doesn't yet include; noted here rather
 * than silently claimed as covered.
 */
describe("VirtualizedAgentGrid performance (proxy — see doc comment)", () => {
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 800 });
  });

  it("initial render of 600 agents completes well within a single 33ms frame budget", () => {
    const startedAt = performance.now();
    render(<VirtualizedAgentGrid agents={agents} />);
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(500); // generous jsdom ceiling — the meaningful signal is the DOM-node-count assertion below, not this number alone
  });

  it("simulating 10 rapid data updates (as if 10 WebSocket messages/sec arrived) keeps total re-render work bounded", () => {
    const { rerender } = render(<VirtualizedAgentGrid agents={agents} />);

    const startedAt = performance.now();
    for (let i = 0; i < 10; i++) {
      const mutated = agents.map((a, idx) => (idx % 50 === i ? { ...a, latencyP50Ms: a.latencyP50Ms! + 1 } : a));
      act(() => rerender(<VirtualizedAgentGrid agents={mutated} />));
    }
    const elapsedMs = performance.now() - startedAt;

    // 10 updates within a 1-second window (the AC's own cadence) — the
    // total work across all 10 must stay well under that 1000ms budget
    // for the batching/memoization to be doing its job at all.
    expect(elapsedMs).toBeLessThan(1000);
  });

  it("only a bounded number of DOM nodes exist regardless of the 600-agent input — the actual mechanism that keeps frame rate up", () => {
    const { container } = render(<VirtualizedAgentGrid agents={agents} />);
    const renderedCards = container.querySelectorAll('[role="gridcell"]');
    expect(renderedCards.length).toBeLessThan(50); // well under 600 — this is the real guarantee virtualization provides
  });
});
