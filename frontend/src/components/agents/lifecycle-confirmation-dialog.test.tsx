import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LifecycleConfirmationDialog } from "./lifecycle-confirmation-dialog";

const PAUSE = { name: "pause" as const, label: "Pause", targetStatus: "paused" as const };
const RETIRE = { name: "retire" as const, label: "Retire", targetStatus: "retired" as const };
const RESUME = { name: "resume" as const, label: "Resume", targetStatus: "active" as const };

describe("LifecycleConfirmationDialog", () => {
  it("shows the action name, agent name, current and target status", () => {
    render(
      <LifecycleConfirmationDialog open action={PAUSE} agentName="Invoice Bot" currentStatus="active" onOpenChange={vi.fn()} onConfirm={vi.fn()} />,
    );
    expect(screen.getByRole("heading", { name: "Pause agent?" })).toBeInTheDocument();
    expect(screen.getByText("Invoice Bot")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Paused")).toBeInTheDocument();
  });

  it("shows the in-flight operations warning when pausing an Active agent", () => {
    render(
      <LifecycleConfirmationDialog open action={PAUSE} agentName="Invoice Bot" currentStatus="active" onOpenChange={vi.fn()} onConfirm={vi.fn()} />,
    );
    expect(
      screen.getByText("This agent has operations that may be in progress. In-flight operations will complete gracefully before the agent fully pauses."),
    ).toBeInTheDocument();
  });

  it("does not show the in-flight warning for Retire", () => {
    render(
      <LifecycleConfirmationDialog open action={RETIRE} agentName="Invoice Bot" currentStatus="active" onOpenChange={vi.fn()} onConfirm={vi.fn()} />,
    );
    expect(screen.queryByText(/in-flight/i)).not.toBeInTheDocument();
  });

  it("does not show the in-flight warning for Resume", () => {
    render(
      <LifecycleConfirmationDialog open action={RESUME} agentName="Invoice Bot" currentStatus="paused" onOpenChange={vi.fn()} onConfirm={vi.fn()} />,
    );
    expect(screen.queryByText(/in-flight/i)).not.toBeInTheDocument();
  });

  it("calls onConfirm when Confirm is clicked", async () => {
    const onConfirm = vi.fn();
    render(
      <LifecycleConfirmationDialog open action={PAUSE} agentName="Invoice Bot" currentStatus="active" onOpenChange={vi.fn()} onConfirm={onConfirm} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalled();
  });

  it("calls onOpenChange(false) when Cancel is clicked", async () => {
    const onOpenChange = vi.fn();
    render(
      <LifecycleConfirmationDialog open action={PAUSE} agentName="Invoice Bot" currentStatus="active" onOpenChange={onOpenChange} onConfirm={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("disables Confirm and Cancel and shows a pending label while isPending", () => {
    render(
      <LifecycleConfirmationDialog open action={PAUSE} agentName="Invoice Bot" currentStatus="active" onOpenChange={vi.fn()} onConfirm={vi.fn()} isPending />,
    );
    expect(screen.getByRole("button", { name: "Confirming…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("does not call onConfirm a second time when Confirm is clicked while pending", async () => {
    const onConfirm = vi.fn();
    render(
      <LifecycleConfirmationDialog open action={PAUSE} agentName="Invoice Bot" currentStatus="active" onOpenChange={vi.fn()} onConfirm={onConfirm} isPending />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Confirming…" }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("renders nothing when closed", () => {
    render(
      <LifecycleConfirmationDialog open={false} action={PAUSE} agentName="Invoice Bot" currentStatus="active" onOpenChange={vi.fn()} onConfirm={vi.fn()} />,
    );
    expect(screen.queryByRole("heading", { name: "Pause agent?" })).not.toBeInTheDocument();
  });
});
