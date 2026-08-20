import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TeamUsageKPICards } from "./team-usage-kpi-cards";
import { expectNoA11yViolations } from "@/test/a11y/axe-setup";
import type { TeamUsageSummary } from "@/types/dashboard";

function summary(overrides: Partial<TeamUsageSummary> = {}): TeamUsageSummary {
  return {
    team: { id: "team-1", name: "Team Alpha" },
    balance: { allocated: 1000, consumed: 400, remaining: 600, utilizationPct: 40 },
    burnRate: { creditsPerDay: 20 },
    agentCount: 5,
    consumptionTrend: [],
    agentComparison: [],
    filtersApplied: { period: "30d", granularity: "daily" },
    servedFromCache: false,
    ...overrides,
  };
}

describe("TeamUsageKPICards", () => {
  it("renders all five KPI cards", () => {
    render(<TeamUsageKPICards summary={summary()} />);
    expect(screen.getByText("Team Credit Balance")).toBeInTheDocument();
    expect(screen.getByText("Consumed (Period)")).toBeInTheDocument();
    expect(screen.getByText("Burn Rate")).toBeInTheDocument();
    expect(screen.getByText("Agent Count")).toBeInTheDocument();
    expect(screen.getByText("Budget Utilization")).toBeInTheDocument();
  });

  it("edge case: a never-budgeted team (utilizationPct null) shows 'Not budgeted', not a fabricated 0%", () => {
    render(<TeamUsageKPICards summary={summary({ balance: { allocated: 0, consumed: 50, remaining: 0, utilizationPct: null } })} />);
    expect(screen.getByText("Not budgeted")).toBeInTheDocument();
  });

  it("edge case: utilization at or above 90% renders with the red warning color", () => {
    render(<TeamUsageKPICards summary={summary({ balance: { allocated: 1000, consumed: 950, remaining: 50, utilizationPct: 95 } })} />);
    const value = screen.getByText("95%");
    expect(value.className).toContain("text-red-700");
  });

  it("has no axe-core accessibility violations", async () => {
    const { container } = render(<TeamUsageKPICards summary={summary()} />);
    await expectNoA11yViolations(container);
  });
});
