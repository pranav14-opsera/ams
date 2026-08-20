import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FrameworkBadge } from "./framework-badge";

describe("FrameworkBadge", () => {
  it("renders LangChain", () => {
    render(<FrameworkBadge framework="langchain" />);
    expect(screen.getByText("LangChain")).toBeInTheDocument();
  });

  it("renders CrewAI", () => {
    render(<FrameworkBadge framework="crewai" />);
    expect(screen.getByText("CrewAI")).toBeInTheDocument();
  });

  it("renders AutoGen", () => {
    render(<FrameworkBadge framework="autogen" />);
    expect(screen.getByText("AutoGen")).toBeInTheDocument();
  });

  it("renders REST for the 'generic_rest' wire value", () => {
    render(<FrameworkBadge framework="generic_rest" />);
    expect(screen.getByText("REST")).toBeInTheDocument();
  });

  it("falls back to a generic badge for an unrecognized framework (edge case: Phase 2 framework types)", () => {
    render(<FrameworkBadge framework="some_future_framework" />);
    expect(screen.getByText("some_future_framework")).toBeInTheDocument();
  });

  it("falls back gracefully for an empty framework string", () => {
    render(<FrameworkBadge framework="" />);
    expect(screen.getByText("Unknown")).toBeInTheDocument();
  });
});
