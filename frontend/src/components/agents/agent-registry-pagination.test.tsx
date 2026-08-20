import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentRegistryPaginationBar } from "./agent-registry-pagination";

describe("AgentRegistryPaginationBar", () => {
  it("shows the total agent count and current range", () => {
    render(<AgentRegistryPaginationBar pagination={{ page: 2, pageSize: 25, total: 60, totalPages: 3 }} onPageChange={vi.fn()} onPageSizeChange={vi.fn()} />);
    expect(screen.getByText("Showing 26–50 of 60 agents")).toBeInTheDocument();
  });

  it("shows a 'No agents' message when total is zero", () => {
    render(<AgentRegistryPaginationBar pagination={{ page: 1, pageSize: 25, total: 0, totalPages: 0 }} onPageChange={vi.fn()} onPageSizeChange={vi.fn()} />);
    expect(screen.getByText("No agents")).toBeInTheDocument();
  });

  it("disables Previous on the first page and Next on the last page", () => {
    render(<AgentRegistryPaginationBar pagination={{ page: 1, pageSize: 25, total: 25, totalPages: 1 }} onPageChange={vi.fn()} onPageSizeChange={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("calls onPageChange with page+1 / page-1", async () => {
    const onPageChange = vi.fn();
    render(<AgentRegistryPaginationBar pagination={{ page: 2, pageSize: 25, total: 100, totalPages: 4 }} onPageChange={onPageChange} onPageSizeChange={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(onPageChange).toHaveBeenCalledWith(3);

    await userEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it("offers all 4 documented page sizes (10/25/50/100) and calls onPageSizeChange", async () => {
    const onPageSizeChange = vi.fn();
    render(<AgentRegistryPaginationBar pagination={{ page: 1, pageSize: 25, total: 100, totalPages: 4 }} onPageChange={vi.fn()} onPageSizeChange={onPageSizeChange} />);

    const select = screen.getByLabelText("Rows per page");
    for (const size of ["10", "25", "50", "100"]) {
      expect(screen.getByRole("option", { name: size })).toBeInTheDocument();
    }
    await userEvent.selectOptions(select, "100");
    expect(onPageSizeChange).toHaveBeenCalledWith(100);
  });
});
