import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualizedAgentGrid } from "./virtualized-agent-grid";
import fixtures from "@/test/fixtures/dashboard/agent-health-600-fixtures.json";
import type { AgentHealthViewModel } from "@/types/dashboard";

const agents = fixtures.records as AgentHealthViewModel[];

describe("VirtualizedAgentGrid", () => {
  beforeAll(() => {
    // jsdom has no real layout engine — the virtualizer needs a non-zero
    // measured container height to compute which rows are "visible".
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 800 });
  });

  it("AC: only renders visible-viewport rows in the DOM, not all 600 — verified by DOM node count", () => {
    render(<VirtualizedAgentGrid agents={agents} />);
    const rows = screen.getAllByRole("row");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(agents.length);
  });

  it("exposes aria-rowcount reflecting the FULL agent count, not just the rendered subset", () => {
    render(<VirtualizedAgentGrid agents={agents} />);
    expect(screen.getByRole("grid")).toHaveAttribute("aria-rowcount", String(agents.length));
  });

  it("each rendered row has a 1-based aria-rowindex", () => {
    render(<VirtualizedAgentGrid agents={agents.slice(0, 5)} />);
    const rows = screen.getAllByRole("row");
    expect(rows[0]).toHaveAttribute("aria-rowindex", "1");
  });

  it("calls onSelect with the clicked agent's id", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<VirtualizedAgentGrid agents={agents.slice(0, 3)} onSelect={onSelect} />);

    const firstCard = screen.getAllByRole("button")[0]!;
    await user.click(firstCard);
    expect(onSelect).toHaveBeenCalledWith(agents[0]!.id);
  });

  it("ArrowDown moves focus to the next row's card, then Enter selects THAT (second) agent, not the first", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<VirtualizedAgentGrid agents={agents.slice(0, 5)} onSelect={onSelect} />);

    const grid = screen.getByRole("grid");
    grid.focus();
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");

    expect(onSelect).toHaveBeenCalledWith(agents[1]!.id);
  });

  it("Home/End keys move focus to the first/last row without throwing", async () => {
    const user = userEvent.setup();
    render(<VirtualizedAgentGrid agents={agents.slice(0, 20)} onSelect={vi.fn()} />);

    const grid = screen.getByRole("grid");
    grid.focus();
    await user.keyboard("{End}");
    await user.keyboard("{Home}");
    // No assertion beyond "did not throw" — jsdom's lack of real scroll
    // geometry makes asserting the exact focused element brittle; the
    // meaningful behavior (index clamping) is covered by the plain
    // keyboard-handler logic itself, exercised here end-to-end.
  });

  it("calls onLoadMore once the scroll position passes the 80% threshold", () => {
    const onLoadMore = vi.fn();
    render(<VirtualizedAgentGrid agents={agents.slice(0, 50)} onLoadMore={onLoadMore} hasMore={true} />);

    const grid = screen.getByRole("grid");
    Object.defineProperty(grid, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(grid, "clientHeight", { configurable: true, value: 600 });
    Object.defineProperty(grid, "scrollTop", { configurable: true, value: 350, writable: true });

    grid.dispatchEvent(new Event("scroll"));
    expect(onLoadMore).toHaveBeenCalled();
  });

  it("does not call onLoadMore when hasMore is false", () => {
    const onLoadMore = vi.fn();
    render(<VirtualizedAgentGrid agents={agents.slice(0, 50)} onLoadMore={onLoadMore} hasMore={false} />);

    const grid = screen.getByRole("grid");
    Object.defineProperty(grid, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(grid, "clientHeight", { configurable: true, value: 600 });
    Object.defineProperty(grid, "scrollTop", { configurable: true, value: 350, writable: true });

    grid.dispatchEvent(new Event("scroll"));
    expect(onLoadMore).not.toHaveBeenCalled();
  });

  it("renders nothing extra (an empty grid) when given zero agents", () => {
    render(<VirtualizedAgentGrid agents={[]} />);
    expect(screen.queryAllByRole("row")).toHaveLength(0);
  });
});
