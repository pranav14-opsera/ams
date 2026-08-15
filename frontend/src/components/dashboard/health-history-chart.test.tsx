import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HealthHistoryChart } from "./health-history-chart";
import fixtures from "@/test/fixtures/health-history/agent-metrics-30d-fixtures.json";
import type { HealthHistoryPoint } from "@/types/dashboard";

const points = fixtures.points as HealthHistoryPoint[];

describe("HealthHistoryChart", () => {
  it("shows an empty-state message when there are no points", () => {
    render(<HealthHistoryChart points={[]} />);
    expect(screen.getByRole("status")).toHaveTextContent("No metric data available");
  });

  it("renders both the latency/error-rate chart and the token-consumption chart when points exist", () => {
    render(<HealthHistoryChart points={points} />);
    expect(screen.getByRole("img", { name: "Latency and error rate over time" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Token consumption over time" })).toBeInTheDocument();
  });

  it("renders chart section headings", () => {
    render(<HealthHistoryChart points={points} />);
    expect(screen.getByText("Latency (P50 / P99) & Error Rate")).toBeInTheDocument();
    expect(screen.getByText("Token Consumption")).toBeInTheDocument();
  });
});
