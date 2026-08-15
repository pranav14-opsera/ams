import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HealthFilterBar } from "./health-filter-bar";

describe("HealthFilterBar", () => {
  it("calls onChange with the updated framework when selected", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<HealthFilterBar filters={{}} onChange={onChange} />);

    await user.selectOptions(screen.getByLabelText("Framework"), "crewai");
    expect(onChange).toHaveBeenCalledWith({ framework: "crewai" });
  });

  it("calls onChange with the updated status when selected", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<HealthFilterBar filters={{ framework: "langchain" }} onChange={onChange} />);

    await user.selectOptions(screen.getByLabelText("Health status"), "error");
    expect(onChange).toHaveBeenCalledWith({ framework: "langchain", status: "error" });
  });

  it("calls onChange with an updated teamId as free text is typed", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<HealthFilterBar filters={{}} onChange={onChange} />);

    await user.type(screen.getByLabelText("Team ID"), "t");
    expect(onChange).toHaveBeenCalledWith({ teamId: "t" });
  });

  it("selecting the placeholder option clears that filter (undefined, not empty string)", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<HealthFilterBar filters={{ framework: "langchain" }} onChange={onChange} />);

    await user.selectOptions(screen.getByLabelText("Framework"), "All frameworks");
    expect(onChange).toHaveBeenCalledWith({ framework: undefined });
  });
});
