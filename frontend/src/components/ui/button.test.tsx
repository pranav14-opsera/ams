import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { Button } from "./button";

describe("Button", () => {
  it("renders its children and responds to a click", async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Get started</Button>);

    const button = screen.getByRole("button", { name: "Get started" });
    expect(button).toBeInTheDocument();

    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("applies the disabled attribute and blocks clicks when disabled", async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Disabled
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Disabled" });
    expect(button).toBeDisabled();

    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("has no axe-core accessibility violations", async () => {
    const { container } = render(<Button>Get started</Button>);
    // color-contrast needs a real canvas 2D context to sample rendered
    // pixels — jsdom doesn't implement one. The E2E axe-core scan
    // (npm run a11y:scan, a real browser via Playwright) is what actually
    // exercises color-contrast; this unit-level check covers everything
    // else (roles, labels, ARIA attributes) on the component in isolation.
    const results = await axe(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results).toHaveNoViolations();
  });
});
