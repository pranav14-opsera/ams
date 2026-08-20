import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AgentRegistryTable } from "./agent-registry-table";
import type { AgentRegistryEntry } from "@/types/dashboard";

function agent(overrides: Partial<AgentRegistryEntry> = {}): AgentRegistryEntry {
  return {
    id: "agent-1",
    name: "Invoice Bot",
    framework: "langchain",
    status: "active",
    team: { id: "team-1", name: "Billing" },
    lastSeen: "2026-08-20T12:00:00.000Z",
    healthScore: null,
    qualityScore: null,
    ...overrides,
  };
}

describe("AgentRegistryTable", () => {
  it("renders one row per agent with name, framework, status, team, and last seen", () => {
    render(
      <AgentRegistryTable
        agents={[agent()]}
        sort={{ sortBy: "name", sortOrder: "asc" }}
        onSortChange={vi.fn()}
        selectedIds={new Set()}
        onToggleRow={vi.fn()}
        onToggleAllOnPage={vi.fn()}
      />,
    );

    expect(screen.getByText("Invoice Bot")).toBeInTheDocument();
    expect(screen.getByText("LangChain")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Billing")).toBeInTheDocument();
  });

  it("shows an em dash for an unassigned team", () => {
    render(
      <AgentRegistryTable
        agents={[agent({ team: null })]}
        sort={{ sortBy: "name", sortOrder: "asc" }}
        onSortChange={vi.fn()}
        selectedIds={new Set()}
        onToggleRow={vi.fn()}
        onToggleAllOnPage={vi.fn()}
      />,
    );
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("shows an empty-state message when there are no agents", () => {
    render(
      <AgentRegistryTable agents={[]} sort={{ sortBy: "name", sortOrder: "asc" }} onSortChange={vi.fn()} selectedIds={new Set()} onToggleRow={vi.fn()} onToggleAllOnPage={vi.fn()} />,
    );
    expect(screen.getByText("No agents match the current filters.")).toBeInTheDocument();
  });

  it("calls onSortChange with the same field and flipped order when the currently-sorted header is clicked", async () => {
    const onSortChange = vi.fn();
    render(
      <AgentRegistryTable
        agents={[agent()]}
        sort={{ sortBy: "name", sortOrder: "asc" }}
        onSortChange={onSortChange}
        selectedIds={new Set()}
        onToggleRow={vi.fn()}
        onToggleAllOnPage={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /sort by name/i }));
    expect(onSortChange).toHaveBeenCalledWith({ sortBy: "name", sortOrder: "desc" });
  });

  it("calls onSortChange with ascending order when switching to a different column", async () => {
    const onSortChange = vi.fn();
    render(
      <AgentRegistryTable
        agents={[agent()]}
        sort={{ sortBy: "name", sortOrder: "asc" }}
        onSortChange={onSortChange}
        selectedIds={new Set()}
        onToggleRow={vi.fn()}
        onToggleAllOnPage={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /sort by framework/i }));
    expect(onSortChange).toHaveBeenCalledWith({ sortBy: "framework", sortOrder: "asc" });
  });

  it("calls onToggleRow when a row checkbox is clicked", async () => {
    const onToggleRow = vi.fn();
    render(
      <AgentRegistryTable
        agents={[agent()]}
        sort={{ sortBy: "name", sortOrder: "asc" }}
        onSortChange={vi.fn()}
        selectedIds={new Set()}
        onToggleRow={onToggleRow}
        onToggleAllOnPage={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole("checkbox", { name: "Select Invoice Bot" }));
    expect(onToggleRow).toHaveBeenCalledWith("agent-1");
  });

  it("calls onToggleAllOnPage when the header select-all checkbox is clicked", async () => {
    const onToggleAllOnPage = vi.fn();
    render(
      <AgentRegistryTable
        agents={[agent()]}
        sort={{ sortBy: "name", sortOrder: "asc" }}
        onSortChange={vi.fn()}
        selectedIds={new Set()}
        onToggleRow={vi.fn()}
        onToggleAllOnPage={onToggleAllOnPage}
      />,
    );

    await userEvent.click(screen.getByRole("checkbox", { name: "Select all agents on this page" }));
    expect(onToggleAllOnPage).toHaveBeenCalled();
  });

  it("checks the header checkbox only when every agent on the page is selected", () => {
    render(
      <AgentRegistryTable
        agents={[agent({ id: "a1" }), agent({ id: "a2" })]}
        sort={{ sortBy: "name", sortOrder: "asc" }}
        onSortChange={vi.fn()}
        selectedIds={new Set(["a1", "a2"])}
        onToggleRow={vi.fn()}
        onToggleAllOnPage={vi.fn()}
      />,
    );
    expect(screen.getByRole("checkbox", { name: "Select all agents on this page" })).toBeChecked();
  });

  it("wraps each status cell in an ARIA live region for real-time announcements", () => {
    render(
      <AgentRegistryTable
        agents={[agent()]}
        sort={{ sortBy: "name", sortOrder: "asc" }}
        onSortChange={vi.fn()}
        selectedIds={new Set()}
        onToggleRow={vi.fn()}
        onToggleAllOnPage={vi.fn()}
      />,
    );
    const statusBadge = screen.getByText("Active");
    const liveRegion = statusBadge.closest('[aria-live="polite"]');
    expect(liveRegion).not.toBeNull();
  });

  it("renders every row within a table with proper row roles (keyboard/screen-reader navigable structure)", () => {
    render(
      <AgentRegistryTable
        agents={[agent({ id: "a1" }), agent({ id: "a2", name: "Second Bot" })]}
        sort={{ sortBy: "name", sortOrder: "asc" }}
        onSortChange={vi.fn()}
        selectedIds={new Set()}
        onToggleRow={vi.fn()}
        onToggleAllOnPage={vi.fn()}
      />,
    );
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(3); // header + 2 data rows
  });
});
