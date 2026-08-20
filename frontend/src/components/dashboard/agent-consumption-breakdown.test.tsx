import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AgentConsumptionBreakdown } from "./agent-consumption-breakdown";
import { expectNoA11yViolations } from "@/test/a11y/axe-setup";
import type { AgentConsumptionEntry } from "@/types/dashboard";

function makeAgents(count: number): AgentConsumptionEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    agentId: `agent-${i}`,
    agentName: `Agent ${i}`,
    framework: "langchain",
    creditsConsumed: (count - i) * 10,
  }));
}

describe("AgentConsumptionBreakdown", () => {
  it("renders the empty state when there are no agents", () => {
    render(<AgentConsumptionBreakdown agents={[]} />);
    expect(screen.getByRole("status")).toHaveTextContent("No agents to display");
  });

  it("shows only the top 10 agents by default, with an expand control for the rest", () => {
    render(<AgentConsumptionBreakdown agents={makeAgents(15)} />);
    const rows = screen.getAllByRole("row"); // includes the header row
    expect(rows.length).toBe(11);
    expect(screen.getByText("Show all 15 agents")).toBeInTheDocument();
  });

  it("expands to the full list when the expand control is clicked", async () => {
    render(<AgentConsumptionBreakdown agents={makeAgents(15)} />);
    await userEvent.click(screen.getByText("Show all 15 agents"));
    const rows = screen.getAllByRole("row");
    expect(rows.length).toBe(16);
    expect(screen.getByText("Show top 10 only")).toBeInTheDocument();
  });

  it("does not show an expand control when there are 10 or fewer agents", () => {
    render(<AgentConsumptionBreakdown agents={makeAgents(5)} />);
    expect(screen.queryByText(/Show all/)).not.toBeInTheDocument();
  });

  it("toggles sort direction and re-sorts the table", async () => {
    render(<AgentConsumptionBreakdown agents={makeAgents(3)} />);
    const table = screen.getAllByRole("table")[0]!;
    const firstRowBefore = within(table).getAllByRole("row")[1];
    expect(firstRowBefore).toHaveTextContent("Agent 0"); // highest consumption (30) first, by default

    await userEvent.click(screen.getByRole("button", { name: /Sort by consumption/ }));
    const firstRowAfter = within(table).getAllByRole("row")[1];
    expect(firstRowAfter).toHaveTextContent("Agent 2"); // lowest consumption (10) first, after toggling
  });

  it("edge case: an agent with zero consumption still appears in both the chart and the table, not omitted", () => {
    const agents: AgentConsumptionEntry[] = [
      { agentId: "a1", agentName: "Busy Agent", framework: "crewai", creditsConsumed: 100 },
      { agentId: "a2", agentName: "Never Used Agent", framework: "autogen", creditsConsumed: 0 },
    ];
    render(<AgentConsumptionBreakdown agents={agents} />);
    expect(screen.getByText("Never Used Agent")).toBeInTheDocument();
  });

  it("has no axe-core accessibility violations", async () => {
    const { container } = render(<AgentConsumptionBreakdown agents={makeAgents(12)} />);
    await expectNoA11yViolations(container);
  });
});
