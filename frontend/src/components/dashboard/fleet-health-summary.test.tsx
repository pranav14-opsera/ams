import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FleetHealthSummary } from "./fleet-health-summary";

describe("FleetHealthSummary", () => {
  it("renders total agent count and each percentage tile", () => {
    render(<FleetHealthSummary summary={{ totalAgents: 42, activePct: 70, degradedPct: 20, errorPct: 10, pausedPct: 0, retiredPct: 0 }} />);

    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("70%")).toBeInTheDocument();
    expect(screen.getByText("20%")).toBeInTheDocument();
    expect(screen.getByText("10%")).toBeInTheDocument();
  });

  it("renders as a labeled group for assistive tech", () => {
    render(<FleetHealthSummary summary={{ totalAgents: 0, activePct: 0, degradedPct: 0, errorPct: 0, pausedPct: 0, retiredPct: 0 }} />);
    expect(screen.getByRole("group", { name: "Fleet health summary" })).toBeInTheDocument();
  });
});
