import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BulkConfirmationDialog } from "./bulk-confirmation-dialog";

const PAUSE = { name: "pause" as const, label: "Pause", targetStatus: "paused" as const };
const RETIRE = { name: "retire" as const, label: "Retire", targetStatus: "retired" as const };

const agents = [
  { id: "a1", name: "Invoice Bot", status: "active" as const },
  { id: "a2", name: "Support Bot", status: "active" as const },
];

describe("BulkConfirmationDialog", () => {
  it("shows the count and target action in the title", () => {
    render(<BulkConfirmationDialog open action={PAUSE} agents={agents} onOpenChange={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Pause 2 agents?" })).toBeInTheDocument();
  });

  it("uses singular phrasing for exactly 1 agent", () => {
    render(<BulkConfirmationDialog open action={PAUSE} agents={[agents[0]!]} onOpenChange={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Pause 1 agent?" })).toBeInTheDocument();
  });

  it("lists the names of every affected agent", () => {
    render(<BulkConfirmationDialog open action={PAUSE} agents={agents} onOpenChange={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByText("Invoice Bot")).toBeInTheDocument();
    expect(screen.getByText("Support Bot")).toBeInTheDocument();
  });

  it("shows the in-flight warning when any selected agent is Active and the action is pause", () => {
    render(<BulkConfirmationDialog open action={PAUSE} agents={agents} onOpenChange={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByText(/In-flight operations will complete gracefully/)).toBeInTheDocument();
  });

  it("does not show the in-flight warning for retire", () => {
    render(<BulkConfirmationDialog open action={RETIRE} agents={agents} onOpenChange={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.queryByText(/in-flight/i)).not.toBeInTheDocument();
  });

  it("calls onConfirm when Confirm is clicked", async () => {
    const onConfirm = vi.fn();
    render(<BulkConfirmationDialog open action={PAUSE} agents={agents} onOpenChange={vi.fn()} onConfirm={onConfirm} />);
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onConfirm).toHaveBeenCalled();
  });

  it("disables Confirm/Cancel while isPending", () => {
    render(<BulkConfirmationDialog open action={PAUSE} agents={agents} onOpenChange={vi.fn()} onConfirm={vi.fn()} isPending />);
    expect(screen.getByRole("button", { name: "Confirming…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });
});
