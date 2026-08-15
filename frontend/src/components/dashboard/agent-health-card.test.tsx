import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentHealthCard } from "./agent-health-card";
import fixtures from "@/test/fixtures/dashboard/agent-health-fixtures.json";
import type { AgentHealthViewModel } from "@/types/dashboard";

const errorAgent = (fixtures.records as AgentHealthViewModel[]).find((a) => a.status === "error")!;

describe("AgentHealthCard", () => {
  it("renders the agent name, semantic status badge, and metrics", () => {
    render(<AgentHealthCard agent={errorAgent} />);
    expect(screen.getByText(errorAgent.name)).toBeInTheDocument();
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.getByText(errorAgent.framework)).toBeInTheDocument();
  });

  it("renders '—' for null metric values instead of blank or 'null'", () => {
    const noMetrics: AgentHealthViewModel = { ...errorAgent, latencyP50Ms: null, latencyP99Ms: null, tokenConsumptionTotal: null, errorRateAvg: null };
    render(<AgentHealthCard agent={noMetrics} />);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("is not clickable when no onSelect is provided", () => {
    render(<AgentHealthCard agent={errorAgent} />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("calls onSelect with the agent id on click, and on Enter/Space when focused", async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<AgentHealthCard agent={errorAgent} onSelect={onSelect} />);

    const card = screen.getByRole("button");
    await user.click(card);
    expect(onSelect).toHaveBeenCalledWith(errorAgent.id);

    onSelect.mockClear();
    card.focus();
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith(errorAgent.id);

    onSelect.mockClear();
    await user.keyboard(" ");
    expect(onSelect).toHaveBeenCalledWith(errorAgent.id);
  });
});
