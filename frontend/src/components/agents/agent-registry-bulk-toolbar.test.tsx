import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentRegistryBulkToolbar } from "./agent-registry-bulk-toolbar";

describe("AgentRegistryBulkToolbar", () => {
  it("renders nothing when no agents are selected", () => {
    const { container } = render(<AgentRegistryBulkToolbar selectedCount={0} onClearSelection={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the selected count", () => {
    render(<AgentRegistryBulkToolbar selectedCount={3} onClearSelection={vi.fn()} />);
    expect(screen.getByText("3 agents selected")).toBeInTheDocument();
  });

  it("uses singular phrasing for exactly 1 selected", () => {
    render(<AgentRegistryBulkToolbar selectedCount={1} onClearSelection={vi.fn()} />);
    expect(screen.getByText("1 agent selected")).toBeInTheDocument();
  });

  it("renders placeholder (disabled) lifecycle action buttons — real wiring is WO-081's scope", () => {
    render(<AgentRegistryBulkToolbar selectedCount={2} onClearSelection={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Pause" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Retire" })).toBeDisabled();
  });

  it("calls onClearSelection when Clear selection is clicked", async () => {
    const onClearSelection = vi.fn();
    render(<AgentRegistryBulkToolbar selectedCount={2} onClearSelection={onClearSelection} />);
    await userEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(onClearSelection).toHaveBeenCalled();
  });

  it("exposes a toolbar role for keyboard/screen-reader users", () => {
    render(<AgentRegistryBulkToolbar selectedCount={1} onClearSelection={vi.fn()} />);
    expect(screen.getByRole("toolbar", { name: "Bulk agent actions" })).toBeInTheDocument();
  });
});
