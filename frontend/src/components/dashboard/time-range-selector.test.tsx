import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TimeRangeSelector } from "./time-range-selector";

describe("TimeRangeSelector", () => {
  it("renders a button for every time range and marks the current value as pressed", () => {
    render(<TimeRangeSelector value="24h" onChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "24h" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "1h" })).toHaveAttribute("aria-pressed", "false");
  });

  it("calls onChange with the clicked range", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<TimeRangeSelector value="24h" onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "7d" }));
    expect(onChange).toHaveBeenCalledWith("7d");
  });

  it("renders as a labeled group for assistive tech", () => {
    render(<TimeRangeSelector value="1h" onChange={vi.fn()} />);
    expect(screen.getByRole("group", { name: "Time range" })).toBeInTheDocument();
  });
});
