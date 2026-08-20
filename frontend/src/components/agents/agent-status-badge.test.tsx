import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentStatusBadge } from "./agent-status-badge";
import { AGENT_LIFECYCLE_STATUSES } from "@/types/dashboard";

describe("AgentStatusBadge", () => {
  it.each(AGENT_LIFECYCLE_STATUSES)("renders a label for the '%s' lifecycle status", (status) => {
    render(<AgentStatusBadge status={status} />);
    expect(screen.getByText(new RegExp(status, "i"))).toBeInTheDocument();
  });

  it("renders all 5 documented lifecycle statuses with distinct text", () => {
    const labels = AGENT_LIFECYCLE_STATUSES.map((status) => {
      const { unmount, container } = render(<AgentStatusBadge status={status} />);
      const text = container.textContent;
      unmount();
      return text;
    });
    expect(new Set(labels).size).toBe(5);
  });
});
