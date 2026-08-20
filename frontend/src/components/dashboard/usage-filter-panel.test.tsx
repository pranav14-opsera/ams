import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UsageFilterPanel } from "./usage-filter-panel";
import { expectNoA11yViolations } from "@/test/a11y/axe-setup";

const ACTION_TYPES = ["agent_execution", "tool_call"];

describe("UsageFilterPanel", () => {
  it("toggling a framework checkbox calls onFiltersChange with that framework added", async () => {
    const onFiltersChange = vi.fn();
    render(<UsageFilterPanel agents={[]} actionTypes={ACTION_TYPES} period="30d" filters={{}} onPeriodChange={vi.fn()} onFiltersChange={onFiltersChange} onReset={vi.fn()} />);
    await userEvent.click(screen.getByLabelText("LangChain"));
    expect(onFiltersChange).toHaveBeenCalledWith({ frameworks: ["langchain"] });
  });

  it("toggling an already-selected framework off removes it (and clears to undefined, not an empty array)", async () => {
    const onFiltersChange = vi.fn();
    render(
      <UsageFilterPanel agents={[]} actionTypes={ACTION_TYPES} period="30d" filters={{ frameworks: ["langchain"] }} onPeriodChange={vi.fn()} onFiltersChange={onFiltersChange} onReset={vi.fn()} />,
    );
    await userEvent.click(screen.getByLabelText("LangChain"));
    expect(onFiltersChange).toHaveBeenCalledWith({ frameworks: undefined });
  });

  it("toggling an action type checkbox calls onFiltersChange with that action type added", async () => {
    const onFiltersChange = vi.fn();
    render(<UsageFilterPanel agents={[]} actionTypes={ACTION_TYPES} period="30d" filters={{}} onPeriodChange={vi.fn()} onFiltersChange={onFiltersChange} onReset={vi.fn()} />);
    await userEvent.click(screen.getByLabelText("tool_call"));
    expect(onFiltersChange).toHaveBeenCalledWith({ actionTypes: ["tool_call"] });
  });

  it("clicking a period button calls onPeriodChange", async () => {
    const onPeriodChange = vi.fn();
    render(<UsageFilterPanel agents={[]} actionTypes={ACTION_TYPES} period="30d" filters={{}} onPeriodChange={onPeriodChange} onFiltersChange={vi.fn()} onReset={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "7 days" }));
    expect(onPeriodChange).toHaveBeenCalledWith("7d");
  });

  it("the reset link only appears once a filter is active", () => {
    const { rerender } = render(<UsageFilterPanel agents={[]} actionTypes={ACTION_TYPES} period="30d" filters={{}} onPeriodChange={vi.fn()} onFiltersChange={vi.fn()} onReset={vi.fn()} />);
    expect(screen.queryByText("Reset filters")).not.toBeInTheDocument();
    rerender(<UsageFilterPanel agents={[]} actionTypes={ACTION_TYPES} period="30d" filters={{ frameworks: ["rest"] }} onPeriodChange={vi.fn()} onFiltersChange={vi.fn()} onReset={vi.fn()} />);
    expect(screen.getByText("Reset filters")).toBeInTheDocument();
  });

  it("agent checkboxes toggle by agentId", async () => {
    const onFiltersChange = vi.fn();
    render(
      <UsageFilterPanel
        agents={[{ agentId: "agent-1", agentName: "Agent One" }]}
        actionTypes={ACTION_TYPES}
        period="30d"
        filters={{}}
        onPeriodChange={vi.fn()}
        onFiltersChange={onFiltersChange}
        onReset={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByLabelText("Agent One"));
    expect(onFiltersChange).toHaveBeenCalledWith({ agentIds: ["agent-1"] });
  });

  it("has no axe-core accessibility violations", async () => {
    const { container } = render(
      <UsageFilterPanel agents={[{ agentId: "agent-1", agentName: "Agent One" }]} actionTypes={ACTION_TYPES} period="30d" filters={{}} onPeriodChange={vi.fn()} onFiltersChange={vi.fn()} onReset={vi.fn()} />,
    );
    await expectNoA11yViolations(container);
  });
});
