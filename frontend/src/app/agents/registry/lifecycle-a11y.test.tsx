import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, vi } from "vitest";
import { AgentActionMenu } from "@/components/agents/agent-action-menu";
import { AgentRegistryBulkToolbar } from "@/components/agents/agent-registry-bulk-toolbar";
import { BulkConfirmationDialog } from "@/components/agents/bulk-confirmation-dialog";
import { BulkResultsDialog } from "@/components/agents/bulk-results-dialog";
import { LifecycleConfirmationDialog } from "@/components/agents/lifecycle-confirmation-dialog";
import { expectNoA11yViolations } from "@/test/a11y/axe-setup";
import type { BulkLifecycleAgentResult } from "@/types/dashboard";

const PAUSE = { name: "pause" as const, label: "Pause", targetStatus: "paused" as const };
const RETIRE = { name: "retire" as const, label: "Retire", targetStatus: "retired" as const };

describe("WO-081 lifecycle UI — axe accessibility (WCAG 2.1 AA)", () => {
  it("AgentActionMenu (open state) has no critical/serious violations", async () => {
    const { container } = render(<AgentActionMenu agentId="a1" agentName="Invoice Bot" status="active" onSelectAction={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Actions for Invoice Bot" }));
    await expectNoA11yViolations(container);
  });

  it("LifecycleConfirmationDialog (with in-flight warning) has no critical/serious violations", async () => {
    const { container } = render(
      <LifecycleConfirmationDialog open action={PAUSE} agentName="Invoice Bot" currentStatus="active" onOpenChange={vi.fn()} onConfirm={vi.fn()} />,
    );
    await expectNoA11yViolations(container);
  });

  it("BulkConfirmationDialog has no critical/serious violations", async () => {
    const { container } = render(
      <BulkConfirmationDialog
        open
        action={RETIRE}
        agents={[
          { id: "a1", name: "Invoice Bot", status: "active" },
          { id: "a2", name: "Support Bot", status: "paused" },
        ]}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    await expectNoA11yViolations(container);
  });

  it("AgentRegistryBulkToolbar has no critical/serious violations", async () => {
    const { container } = render(
      <AgentRegistryBulkToolbar
        selectedAgents={[
          { id: "a1", name: "Invoice Bot", status: "active" },
          { id: "a2", name: "Support Bot", status: "active" },
        ]}
        onClearSelection={vi.fn()}
        onAction={vi.fn()}
      />,
    );
    await expectNoA11yViolations(container);
  });

  it("AgentRegistryBulkToolbar's own 'no common actions' state has no critical/serious violations", async () => {
    const { container } = render(
      <AgentRegistryBulkToolbar
        selectedAgents={[
          { id: "a1", name: "Invoice Bot", status: "active" },
          { id: "a2", name: "Retired Bot", status: "retired" },
        ]}
        onClearSelection={vi.fn()}
        onAction={vi.fn()}
      />,
    );
    await expectNoA11yViolations(container);
  });

  it("BulkResultsDialog (mixed success/failure) has no critical/serious violations", async () => {
    const results: BulkLifecycleAgentResult[] = [
      { agentId: "a1", status: "success", previousStatus: "active", newStatus: "retired", warning: null, error: null },
      { agentId: "a2", status: "failed", previousStatus: null, newStatus: null, warning: null, error: "Cannot transition agent from \"retired\" via pause." },
    ];
    const { container } = render(
      <BulkResultsDialog
        open
        onClose={vi.fn()}
        agentNames={
          new Map([
            ["a1", "Invoice Bot"],
            ["a2", "Support Bot"],
          ])
        }
        results={results}
        onRetryFailed={vi.fn()}
      />,
    );
    await expectNoA11yViolations(container);
  });
});
