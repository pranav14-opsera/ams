import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MobileDrawer } from "./mobile-drawer";

describe("MobileDrawer", () => {
  it("renders its children only while open", () => {
    const { rerender } = render(
      <MobileDrawer open={false} onOpenChange={() => undefined}>
        <div>Nav content</div>
      </MobileDrawer>,
    );
    expect(screen.queryByText("Nav content")).not.toBeInTheDocument();

    rerender(
      <MobileDrawer open onOpenChange={() => undefined}>
        <div>Nav content</div>
      </MobileDrawer>,
    );
    expect(screen.getByText("Nav content")).toBeInTheDocument();
  });

  it("has a labeled, focusable close button", () => {
    render(
      <MobileDrawer open onOpenChange={() => undefined}>
        <div>Nav content</div>
      </MobileDrawer>,
    );
    expect(screen.getByRole("button", { name: "Close navigation" })).toBeInTheDocument();
  });

  it("calls onOpenChange(false) when the close button is clicked", async () => {
    const onOpenChange = vi.fn();
    render(
      <MobileDrawer open onOpenChange={onOpenChange}>
        <div>Nav content</div>
      </MobileDrawer>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Close navigation" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("calls onOpenChange(false) when Escape is pressed (Radix Dialog's own default behavior)", async () => {
    const onOpenChange = vi.fn();
    render(
      <MobileDrawer open onOpenChange={onOpenChange}>
        <div>Nav content</div>
      </MobileDrawer>,
    );
    await userEvent.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("moves focus inside the drawer on open (Radix Dialog's own default behavior — the first focusable descendant, here the close button)", () => {
    render(
      <MobileDrawer open onOpenChange={() => undefined}>
        <button type="button">Inside item</button>
      </MobileDrawer>,
    );
    // Radix Dialog auto-focuses the first focusable element within its
    // content on open — proof focus starts inside the trapped scope, not
    // on document.body or anything behind the overlay.
    expect(screen.getByRole("button", { name: "Close navigation" })).toHaveFocus();
  });
});
