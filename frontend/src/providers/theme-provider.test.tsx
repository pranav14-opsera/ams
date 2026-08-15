import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ThemeProvider } from "./theme-provider";

describe("ThemeProvider", () => {
  it("mounts and renders its children", () => {
    render(
      <ThemeProvider>
        <div>themed content</div>
      </ThemeProvider>,
    );

    expect(screen.getByText("themed content")).toBeInTheDocument();
  });
});
