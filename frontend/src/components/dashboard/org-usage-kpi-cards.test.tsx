import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OrgUsageKPICards } from "./org-usage-kpi-cards";
import { expectNoA11yViolations } from "@/test/a11y/axe-setup";
import type { OrgUsageSummary } from "@/types/dashboard";

function summary(overrides: Partial<OrgUsageSummary> = {}): OrgUsageSummary {
  return {
    balance: { total: 1000, consumed: 400, remaining: 600 },
    burnRate: { creditsPerDay: 20, projectedExhaustionDate: "2026-09-19" },
    activeAgents: 7,
    consumptionTrend: [],
    agentBreakdown: [],
    servedFromCache: false,
    ...overrides,
  };
}

describe("OrgUsageKPICards", () => {
  it("renders all five KPI cards", () => {
    render(<OrgUsageKPICards summary={summary()} />);
    expect(screen.getByText("Total Credit Balance")).toBeInTheDocument();
    expect(screen.getByText("Credits Consumed (Period)")).toBeInTheDocument();
    expect(screen.getByText("Burn Rate")).toBeInTheDocument();
    expect(screen.getByText("Active Agents")).toBeInTheDocument();
    expect(screen.getByText("Projected Exhaustion")).toBeInTheDocument();
  });

  it("formats the balance and active agent count", () => {
    render(<OrgUsageKPICards summary={summary({ balance: { total: 12345, consumed: 400, remaining: 11945 }, activeAgents: 42 })} />);
    expect(screen.getByText("12,345")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("edge case: exhausted budget (remaining <= 0) shows 'Budget exhausted'", () => {
    render(<OrgUsageKPICards summary={summary({ balance: { total: 500, consumed: 500, remaining: 0 }, burnRate: { creditsPerDay: 10, projectedExhaustionDate: null } })} />);
    expect(screen.getByText("Budget exhausted")).toBeInTheDocument();
  });

  it("edge case: zero burn rate with a positive remaining balance shows a 'not projected' message, not a bogus date", () => {
    render(<OrgUsageKPICards summary={summary({ burnRate: { creditsPerDay: 0, projectedExhaustionDate: null } })} />);
    expect(screen.getByText("Not projected (no recent usage)")).toBeInTheDocument();
  });

  it("has no axe-core accessibility violations", async () => {
    const { container } = render(<OrgUsageKPICards summary={summary()} />);
    await expectNoA11yViolations(container);
  });
});
