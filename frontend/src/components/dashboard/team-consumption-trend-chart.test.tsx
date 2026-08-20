import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TeamConsumptionTrendChart } from "./team-consumption-trend-chart";
import { expectNoA11yViolations } from "@/test/a11y/axe-setup";

describe("TeamConsumptionTrendChart", () => {
  it("edge case: no points under the current filter combination shows an empty state, not a broken chart", () => {
    render(<TeamConsumptionTrendChart points={[]} />);
    expect(screen.getByRole("status")).toHaveTextContent("No consumption data available for this filter combination");
  });

  it("renders a keyboard-navigable data table alternative to the chart", () => {
    render(<TeamConsumptionTrendChart points={[{ date: "2026-08-01T00:00:00.000Z", credits: 40 }]} />);
    expect(screen.getByText("View as table")).toBeInTheDocument();
    expect(screen.getByText("40")).toBeInTheDocument();
  });

  it("has no axe-core accessibility violations", async () => {
    const { container } = render(<TeamConsumptionTrendChart points={[{ date: "2026-08-01T00:00:00.000Z", credits: 40 }]} />);
    await expectNoA11yViolations(container);
  });
});
