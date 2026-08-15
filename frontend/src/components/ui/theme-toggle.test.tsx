import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ThemeProvider } from "@/providers/theme-provider";
import { ThemeToggle } from "./theme-toggle";

function renderToggle() {
  return render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>,
  );
}

describe("ThemeToggle", () => {
  it("renders a labeled trigger button", () => {
    renderToggle();
    expect(screen.getByRole("button", { name: "Toggle theme" })).toBeInTheDocument();
  });

  it("opens a menu with all three options: Light, Dark, System", async () => {
    renderToggle();
    await userEvent.click(screen.getByRole("button", { name: "Toggle theme" }));

    expect(screen.getByRole("menuitem", { name: /Light/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Dark/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /System/ })).toBeInTheDocument();
  });

  it("selecting Dark applies the .dark class to <html>", async () => {
    renderToggle();
    await userEvent.click(screen.getByRole("button", { name: "Toggle theme" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Dark/ }));

    expect(document.documentElement).toHaveClass("dark");
  });

  it("selecting Light removes the .dark class from <html>", async () => {
    renderToggle();
    await userEvent.click(screen.getByRole("button", { name: "Toggle theme" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Dark/ }));
    expect(document.documentElement).toHaveClass("dark");

    await userEvent.click(screen.getByRole("button", { name: "Toggle theme" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Light/ }));
    expect(document.documentElement).not.toHaveClass("dark");
  });

  it("marks the currently active theme with a check mark", async () => {
    renderToggle();
    await userEvent.click(screen.getByRole("button", { name: "Toggle theme" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Dark/ }));

    await userEvent.click(screen.getByRole("button", { name: "Toggle theme" }));
    const darkItem = screen.getByRole("menuitem", { name: /Dark/ });
    expect(darkItem.querySelector('[aria-label="current theme"]')).toBeInTheDocument();
  });

  it("persists the selection to localStorage under the 'theme' key", async () => {
    renderToggle();
    await userEvent.click(screen.getByRole("button", { name: "Toggle theme" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Dark/ }));

    expect(window.localStorage.getItem("theme")).toBe("dark");
  });
});
