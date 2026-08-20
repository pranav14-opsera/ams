import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentComparisonChart } from "./agent-comparison-chart";
import { expectNoA11yViolations } from "@/test/a11y/axe-setup";
import type { TeamAgentComparisonEntry } from "@/types/dashboard";

function agents(overrides: TeamAgentComparisonEntry[] = []): TeamAgentComparisonEntry[] {
  return overrides.length > 0
    ? overrides
    : [
        { agentId: "agent-1", agentName: "Normal Agent", framework: "langchain", creditsConsumed: 10, isAboveThreshold: false },
        { agentId: "agent-2", agentName: "Hotspot Agent", framework: "crewai", creditsConsumed: 80, isAboveThreshold: true },
      ];
}

describe("AgentComparisonChart", () => {
  it("edge case: a zero-agent team shows an empty state, not a broken chart", () => {
    render(<AgentComparisonChart agents={[]} />);
    expect(screen.getByRole("status")).toHaveTextContent("no agents to compare");
  });

  it("flags an agent above the 2x threshold as 'Above 2x average' in the accessible table", () => {
    render(<AgentComparisonChart agents={agents()} />);
    const rows = screen.getAllByRole("row");
    const hotspotRow = rows.find((r) => r.textContent?.includes("Hotspot Agent"));
    expect(hotspotRow?.textContent).toContain("Above 2x average");
    const normalRow = rows.find((r) => r.textContent?.includes("Normal Agent"));
    expect(normalRow?.textContent).toContain("Normal");
  });

  it("shows only the top 10 by default with an expand control when there are more agents", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({ agentId: `agent-${i}`, agentName: `Agent ${i}`, framework: "langchain", creditsConsumed: i, isAboveThreshold: false }));
    render(<AgentComparisonChart agents={many} />);
    expect(screen.getByText("Show all 15 agents")).toBeInTheDocument();
  });

  it("has no axe-core accessibility violations", async () => {
    const { container } = render(<AgentComparisonChart agents={agents()} />);
    await expectNoA11yViolations(container);
  });
});
