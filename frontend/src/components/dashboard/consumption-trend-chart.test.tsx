import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConsumptionTrendChart } from "./consumption-trend-chart";
import { expectNoA11yViolations } from "@/test/a11y/axe-setup";

const POINTS = [
  { date: "2026-07-20T00:00:00.000Z", credits: 10 },
  { date: "2026-07-21T00:00:00.000Z", credits: 15 },
];

describe("ConsumptionTrendChart", () => {
  it("renders the empty state when there are no points (new-tenant edge case)", () => {
    render(<ConsumptionTrendChart points={[]} period="30d" onPeriodChange={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("No consumption data available");
  });

  it("renders the chart and a keyboard-navigable table alternative with the same data", async () => {
    render(<ConsumptionTrendChart points={POINTS} period="30d" onPeriodChange={vi.fn()} />);
    await userEvent.click(screen.getByText("View as table"));
    expect(screen.getAllByText("10")).toHaveLength(1);
    expect(screen.getAllByText("15")).toHaveLength(1);
  });

  it("calls onPeriodChange when a different period toggle is clicked", async () => {
    const onPeriodChange = vi.fn();
    render(<ConsumptionTrendChart points={POINTS} period="30d" onPeriodChange={onPeriodChange} />);
    await userEvent.click(screen.getByRole("button", { name: "60 days" }));
    expect(onPeriodChange).toHaveBeenCalledWith("60d");
  });

  it("marks the active period button as pressed", () => {
    render(<ConsumptionTrendChart points={POINTS} period="90d" onPeriodChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "90 days" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "30 days" })).toHaveAttribute("aria-pressed", "false");
  });

  it("has no axe-core accessibility violations", async () => {
    const { container } = render(<ConsumptionTrendChart points={POINTS} period="30d" onPeriodChange={vi.fn()} />);
    await expectNoA11yViolations(container);
  });
});
