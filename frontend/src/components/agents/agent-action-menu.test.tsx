import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentActionMenu } from "./agent-action-menu";
import type { AgentLifecycleStatus } from "@/types/dashboard";

describe("AgentActionMenu", () => {
  it("renders nothing for a Connecting agent (no valid lifecycle actions)", () => {
    const { container } = render(<AgentActionMenu agentId="a1" agentName="Bot" status="connecting" onSelectAction={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for a Decommissioned agent", () => {
    const { container } = render(<AgentActionMenu agentId="a1" agentName="Bot" status="decommissioned" onSelectAction={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a menu trigger for an Active agent", () => {
    render(<AgentActionMenu agentId="a1" agentName="Invoice Bot" status="active" onSelectAction={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Actions for Invoice Bot" })).toBeInTheDocument();
  });

  it("lists Pause and Retire for an Active agent", async () => {
    render(<AgentActionMenu agentId="a1" agentName="Invoice Bot" status="active" onSelectAction={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Actions for Invoice Bot" }));
    expect(screen.getByRole("menuitem", { name: /Pause/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Retire/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Resume/ })).not.toBeInTheDocument();
  });

  it("lists Resume and Retire for a Paused agent", async () => {
    render(<AgentActionMenu agentId="a1" agentName="Invoice Bot" status="paused" onSelectAction={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Actions for Invoice Bot" }));
    expect(screen.getByRole("menuitem", { name: /Resume/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Retire/ })).toBeInTheDocument();
  });

  it("lists only Decommission for a Retired agent", async () => {
    render(<AgentActionMenu agentId="a1" agentName="Invoice Bot" status="retired" onSelectAction={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Actions for Invoice Bot" }));
    expect(screen.getByRole("menuitem", { name: /Decommission/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Retire/ })).not.toBeInTheDocument();
  });

  it("calls onSelectAction with the chosen action when a menu item is selected", async () => {
    const onSelectAction = vi.fn();
    render(<AgentActionMenu agentId="a1" agentName="Invoice Bot" status="active" onSelectAction={onSelectAction} />);
    await userEvent.click(screen.getByRole("button", { name: "Actions for Invoice Bot" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Pause/ }));
    expect(onSelectAction).toHaveBeenCalledWith({ name: "pause", label: "Pause", targetStatus: "paused" });
  });

  it("shows a loading spinner instead of the menu trigger while transitioning", () => {
    render(<AgentActionMenu agentId="a1" agentName="Invoice Bot" status="active" onSelectAction={vi.fn()} isTransitioning />);
    expect(screen.queryByRole("button", { name: "Actions for Invoice Bot" })).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Invoice Bot is transitioning" })).toBeInTheDocument();
  });

  it.each(["connecting", "active", "paused", "retired", "decommissioned"] as AgentLifecycleStatus[])(
    "never throws for status=%s",
    (status) => {
      expect(() => render(<AgentActionMenu agentId="a1" agentName="Bot" status={status} onSelectAction={vi.fn()} />)).not.toThrow();
    },
  );
});
