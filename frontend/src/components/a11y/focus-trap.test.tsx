import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { FocusTrap } from "./focus-trap";

describe("FocusTrap", () => {
  it("auto-focuses the first focusable descendant on mount", () => {
    render(
      <FocusTrap>
        <button type="button">First</button>
        <button type="button">Second</button>
      </FocusTrap>,
    );
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
  });

  it("Tab cycles from the last item back to the first when loop is true", async () => {
    render(
      <FocusTrap loop>
        <button type="button">First</button>
        <button type="button">Second</button>
      </FocusTrap>,
    );

    screen.getByRole("button", { name: "Second" }).focus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
  });

  it("restores focus to the previously focused element on unmount", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Trigger";
    document.body.appendChild(trigger);
    trigger.focus();
    expect(trigger).toHaveFocus();

    const { unmount } = render(
      <FocusTrap>
        <button type="button">Inside</button>
      </FocusTrap>,
    );
    expect(screen.getByRole("button", { name: "Inside" })).toHaveFocus();

    unmount();
    // Radix FocusScope restores focus via a rAF-scheduled callback, not synchronously.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(trigger).toHaveFocus();
    trigger.remove();
  });
});
