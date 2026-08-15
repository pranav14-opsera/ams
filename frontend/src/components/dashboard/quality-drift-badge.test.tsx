import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { QualityDriftBadge } from "./quality-drift-badge";

describe("QualityDriftBadge", () => {
  it("renders the quality score", () => {
    render(<QualityDriftBadge qualityScore={87} driftStatus="stable" />);
    expect(screen.getByText("87")).toBeInTheDocument();
  });

  it("renders '—' instead of a fabricated number when qualityScore is null", () => {
    render(<QualityDriftBadge qualityScore={null} driftStatus="insufficient_data" />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it.each([
    ["stable", "Stable"],
    ["drifting_up", "Drifting (degrading)"],
    ["drifting_down", "Drifting (improving)"],
    ["insufficient_data", "Insufficient data"],
  ] as const)("renders the correct label for drift status '%s'", (status, label) => {
    render(<QualityDriftBadge qualityScore={50} driftStatus={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });
});
