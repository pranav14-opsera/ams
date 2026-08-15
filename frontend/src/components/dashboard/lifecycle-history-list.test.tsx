import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LifecycleHistoryList } from "./lifecycle-history-list";
import type { LifecycleHistoryEntry } from "@/types/dashboard";

const entries: LifecycleHistoryEntry[] = [
  { fromStatus: "connecting", toStatus: "active", reason: "initial activation", triggeredBy: "user-1", occurredAt: "2026-08-01T00:00:00.000Z" },
  { fromStatus: "active", toStatus: "paused", reason: null, triggeredBy: null, occurredAt: "2026-08-05T00:00:00.000Z" },
];

describe("LifecycleHistoryList", () => {
  it("shows an empty-state message when there are no entries", () => {
    render(<LifecycleHistoryList entries={[]} />);
    expect(screen.getByRole("status")).toHaveTextContent("No lifecycle transitions recorded");
  });

  it("renders every transition with its reason and actor when present", () => {
    render(<LifecycleHistoryList entries={entries} />);
    expect(screen.getByText(/initial activation/)).toBeInTheDocument();
    expect(screen.getByText(/user-1/)).toBeInTheDocument();
  });

  it("does not render a dangling separator when reason/actor are null", () => {
    render(<LifecycleHistoryList entries={entries} />);
    const items = screen.getAllByRole("listitem");
    expect(items[1]?.textContent).not.toContain("null");
  });
});
