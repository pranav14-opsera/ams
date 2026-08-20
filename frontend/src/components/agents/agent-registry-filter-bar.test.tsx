import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentRegistryFilterBar } from "./agent-registry-filter-bar";

describe("AgentRegistryFilterBar", () => {
  it("toggles a framework on when its checkbox is checked", async () => {
    const onChange = vi.fn();
    render(<AgentRegistryFilterBar filters={{}} onChange={onChange} />);

    await userEvent.click(screen.getByRole("checkbox", { name: "LangChain" }));
    expect(onChange).toHaveBeenCalledWith({ framework: ["langchain"] });
  });

  it("toggles a framework off when already selected", async () => {
    const onChange = vi.fn();
    render(<AgentRegistryFilterBar filters={{ framework: ["langchain", "crewai"] }} onChange={onChange} />);

    await userEvent.click(screen.getByRole("checkbox", { name: "LangChain" }));
    expect(onChange).toHaveBeenCalledWith({ framework: ["crewai"] });
  });

  it("clears the framework key entirely once the last selected value is toggled off", async () => {
    const onChange = vi.fn();
    render(<AgentRegistryFilterBar filters={{ framework: ["langchain"] }} onChange={onChange} />);

    await userEvent.click(screen.getByRole("checkbox", { name: "LangChain" }));
    expect(onChange).toHaveBeenCalledWith({ framework: undefined });
  });

  it("toggles a lifecycle status", async () => {
    const onChange = vi.fn();
    render(<AgentRegistryFilterBar filters={{}} onChange={onChange} />);

    await userEvent.click(screen.getByRole("checkbox", { name: "Active" }));
    expect(onChange).toHaveBeenCalledWith({ status: ["active"] });
  });

  it("updates teamId from the free-text field", async () => {
    const onChange = vi.fn();
    render(<AgentRegistryFilterBar filters={{}} onChange={onChange} />);

    await userEvent.type(screen.getByPlaceholderText("Filter by team UUID"), "t");
    expect(onChange).toHaveBeenCalledWith({ teamId: "t" });
  });

  it("shows a reset button only when a filter is active, and resets to an empty filter set", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<AgentRegistryFilterBar filters={{}} onChange={onChange} />);
    expect(screen.queryByText("Reset filters")).not.toBeInTheDocument();

    rerender(<AgentRegistryFilterBar filters={{ framework: ["langchain"] }} onChange={onChange} />);
    await userEvent.click(screen.getByText("Reset filters"));
    expect(onChange).toHaveBeenCalledWith({});
  });
});
