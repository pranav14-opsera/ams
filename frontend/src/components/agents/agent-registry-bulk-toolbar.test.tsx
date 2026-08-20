import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentRegistryBulkToolbar, type BulkToolbarAgentSummary } from "./agent-registry-bulk-toolbar";

function summary(overrides: Partial<BulkToolbarAgentSummary> = {}): BulkToolbarAgentSummary {
  return { id: "agent-1", name: "Invoice Bot", status: "active", ...overrides };
}

describe("AgentRegistryBulkToolbar", () => {
  it("renders nothing when no agents are selected", () => {
    const { container } = render(<AgentRegistryBulkToolbar selectedAgents={[]} onClearSelection={vi.fn()} onAction={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the selected count", () => {
    render(
      <AgentRegistryBulkToolbar
        selectedAgents={[summary({ id: "a1" }), summary({ id: "a2" }), summary({ id: "a3" })]}
        onClearSelection={vi.fn()}
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByText("3 agents selected")).toBeInTheDocument();
  });

  it("uses singular phrasing for exactly 1 selected", () => {
    render(<AgentRegistryBulkToolbar selectedAgents={[summary()]} onClearSelection={vi.fn()} onAction={vi.fn()} />);
    expect(screen.getByText("1 agent selected")).toBeInTheDocument();
  });

  it("enables only actions valid for ALL selected agents — Active + Active shows Pause and Retire enabled, Resume/Decommission disabled", () => {
    render(
      <AgentRegistryBulkToolbar
        selectedAgents={[summary({ id: "a1", status: "active" }), summary({ id: "a2", status: "active" })]}
        onClearSelection={vi.fn()}
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Pause" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Retire" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Resume" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Decommission" })).toBeDisabled();
  });

  it("intersects mixed Active + Paused selections down to just Retire", () => {
    render(
      <AgentRegistryBulkToolbar
        selectedAgents={[summary({ id: "a1", status: "active" }), summary({ id: "a2", status: "paused" })]}
        onClearSelection={vi.fn()}
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Retire" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Pause" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Resume" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Decommission" })).toBeDisabled();
  });

  it("shows a 'no common actions' message and disables every action when selections have nothing in common", () => {
    render(
      <AgentRegistryBulkToolbar
        selectedAgents={[summary({ id: "a1", status: "active" }), summary({ id: "a2", status: "retired" })]}
        onClearSelection={vi.fn()}
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByText("No common actions available for selected agents")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Resume" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Retire" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Decommission" })).toBeDisabled();
  });

  it("calls onAction with the chosen lifecycle action when an enabled button is clicked", async () => {
    const onAction = vi.fn();
    render(<AgentRegistryBulkToolbar selectedAgents={[summary({ status: "active" })]} onClearSelection={vi.fn()} onAction={onAction} />);
    await userEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(onAction).toHaveBeenCalledWith({ name: "pause", label: "Pause", targetStatus: "paused" });
  });

  it("disables every action and clear-selection while a bulk operation is pending", () => {
    render(<AgentRegistryBulkToolbar selectedAgents={[summary({ status: "active" })]} onClearSelection={vi.fn()} onAction={vi.fn()} isPending />);
    expect(screen.getByRole("button", { name: "Pause" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear selection" })).toBeDisabled();
    expect(screen.getByText("Applying…")).toBeInTheDocument();
  });

  it("calls onClearSelection when Clear selection is clicked", async () => {
    const onClearSelection = vi.fn();
    render(<AgentRegistryBulkToolbar selectedAgents={[summary({ id: "a1" }), summary({ id: "a2" })]} onClearSelection={onClearSelection} onAction={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(onClearSelection).toHaveBeenCalled();
  });

  it("exposes a toolbar role for keyboard/screen-reader users", () => {
    render(<AgentRegistryBulkToolbar selectedAgents={[summary()]} onClearSelection={vi.fn()} onAction={vi.fn()} />);
    expect(screen.getByRole("toolbar", { name: "Bulk agent actions" })).toBeInTheDocument();
  });
});
