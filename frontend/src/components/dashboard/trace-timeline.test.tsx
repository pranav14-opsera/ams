import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TraceTimeline } from "./trace-timeline";
import fixtures from "@/test/fixtures/traces/agent-trace-fixtures.json";
import type { AgentExecutionTrace } from "@/types/dashboard";

const traces = fixtures.traces as AgentExecutionTrace[];

describe("TraceTimeline", () => {
  it("shows an empty-state message when there are no traces", () => {
    render(<TraceTimeline traces={[]} />);
    expect(screen.getByRole("status")).toHaveTextContent("No recent execution traces");
  });

  it("renders one entry per trace with its status badge", () => {
    render(<TraceTimeline traces={traces} />);
    expect(screen.getByText("completed")).toBeInTheDocument();
    expect(screen.getByText("failed")).toBeInTheDocument();
  });

  it("renders every step's name, tool name, and duration", () => {
    render(<TraceTimeline traces={traces} />);
    expect(screen.getAllByText(/retrieve_context \(vector_search\)/).length).toBe(traces.length);
    expect(screen.getAllByText(/\d+ms/).length).toBeGreaterThan(0);
  });

  it("visually highlights a [MASKED] PHI placeholder distinctly from surrounding text", () => {
    render(<TraceTimeline traces={traces} />);
    const maskEl = screen.getByText("[MASKED]");
    expect(maskEl.tagName.toLowerCase()).toBe("mark");
  });

  it("does not mark up ordinary, non-PHI text as masked", () => {
    render(<TraceTimeline traces={traces} />);
    expect(screen.queryByText("Standard query, no PHI-shaped content")).toBeInTheDocument();
    expect(screen.getAllByText("[MASKED]", { exact: false })).toHaveLength(1);
  });
});
