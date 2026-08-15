import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SkipToContent } from "./skip-to-content";

describe("SkipToContent", () => {
  it("renders a link targeting #main-content", () => {
    render(<SkipToContent />);
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute("href", "#main-content");
  });

  it("is visually hidden by default (sr-only) but not aria-hidden", () => {
    render(<SkipToContent />);
    const link = screen.getByRole("link", { name: "Skip to content" });
    expect(link).toHaveClass("sr-only");
    expect(link).not.toHaveAttribute("aria-hidden");
  });
});
