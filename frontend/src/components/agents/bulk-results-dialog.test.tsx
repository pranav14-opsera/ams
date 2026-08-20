import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { BulkResultsDialog } from "./bulk-results-dialog";
import type { BulkLifecycleAgentResult } from "@/types/dashboard";

const agentNames = new Map([
  ["a1", "Invoice Bot"],
  ["a2", "Support Bot"],
  ["a3", "Ops Bot"],
]);

const mixedResults: BulkLifecycleAgentResult[] = [
  { agentId: "a1", status: "success", previousStatus: "active", newStatus: "paused", warning: null, error: null },
  { agentId: "a2", status: "success", previousStatus: "active", newStatus: "paused", warning: null, error: null },
  { agentId: "a3", status: "failed", previousStatus: null, newStatus: null, warning: null, error: "Cannot transition agent from \"retired\" via pause." },
];

describe("BulkResultsDialog", () => {
  it("renders nothing when closed", () => {
    const { container } = render(<BulkResultsDialog open={false} onClose={vi.fn()} agentNames={agentNames} results={mixedResults} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a summary count of successes and failures", () => {
    render(<BulkResultsDialog open onClose={vi.fn()} agentNames={agentNames} results={mixedResults} />);
    expect(screen.getByText("2 succeeded, 1 failed out of 3 agents.")).toBeInTheDocument();
  });

  it("shows each successful agent with its name and transition", () => {
    render(<BulkResultsDialog open onClose={vi.fn()} agentNames={agentNames} results={mixedResults} />);
    expect(screen.getByText("Invoice Bot")).toBeInTheDocument();
    expect(screen.getByText("Support Bot")).toBeInTheDocument();
    expect(screen.getAllByText("active → paused")).toHaveLength(2);
  });

  it("shows the failed agent with its error message", () => {
    render(<BulkResultsDialog open onClose={vi.fn()} agentNames={agentNames} results={mixedResults} />);
    expect(screen.getByText("Ops Bot")).toBeInTheDocument();
    expect(screen.getByText('Cannot transition agent from "retired" via pause.')).toBeInTheDocument();
  });

  it("renders a full-success result set with no Retry Failed button", () => {
    const allSuccess: BulkLifecycleAgentResult[] = [{ agentId: "a1", status: "success", previousStatus: "active", newStatus: "paused", warning: null, error: null }];
    render(<BulkResultsDialog open onClose={vi.fn()} agentNames={agentNames} results={allSuccess} onRetryFailed={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Retry Failed" })).not.toBeInTheDocument();
  });

  it("renders a full-failure result set", () => {
    const allFailed: BulkLifecycleAgentResult[] = [{ agentId: "a3", status: "failed", previousStatus: null, newStatus: null, warning: null, error: "Forbidden" }];
    render(<BulkResultsDialog open onClose={vi.fn()} agentNames={agentNames} results={allFailed} />);
    expect(screen.getByText("0 succeeded, 1 failed out of 1 agent.")).toBeInTheDocument();
  });

  it("shows a Retry Failed button when there are failures and an onRetryFailed handler is provided", async () => {
    const onRetryFailed = vi.fn();
    render(<BulkResultsDialog open onClose={vi.fn()} agentNames={agentNames} results={mixedResults} onRetryFailed={onRetryFailed} />);
    await userEvent.click(screen.getByRole("button", { name: "Retry Failed" }));
    expect(onRetryFailed).toHaveBeenCalledWith(["a3"]);
  });

  it("calls onClose when Close is clicked", async () => {
    const onClose = vi.fn();
    render(<BulkResultsDialog open onClose={onClose} agentNames={agentNames} results={mixedResults} />);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose on Escape", async () => {
    const onClose = vi.fn();
    render(<BulkResultsDialog open onClose={onClose} agentNames={agentNames} results={mixedResults} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("exposes a dialog role for screen-reader users", () => {
    render(<BulkResultsDialog open onClose={vi.fn()} agentNames={agentNames} results={mixedResults} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});
