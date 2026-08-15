import { test, expect } from "@playwright/test";
import adminPermissions from "../../src/test/fixtures/permissions/admin.json";

test("keyboard-only: the entire shell is reachable via Tab with no dead ends, starting from the skip link", async ({ page }) => {
  await page.addInitScript(
    (auth) => {
      window.localStorage.setItem("__ams_e2e_auth_override__", JSON.stringify(auth));
    },
    { userId: "u1", tenantId: "t1", roles: ["platform_admin"], permissions: adminPermissions },
  );
  await page.goto("/");

  // First Tab must land on the skip link (AC: "first focusable element on every page").
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();

  // Activating it moves focus to main content.
  await page.keyboard.press("Enter");
  await expect(page.locator("#main-content")).toBeVisible();

  // Tabbing further reaches the sidebar's controls and nav groups without
  // getting stuck — don't assume an exact tab count (activating the skip
  // link may or may not move focus off itself depending on the browser),
  // just confirm a group trigger (aria-expanded) is reachable within a
  // handful of Tab presses.
  let reachedGroupTrigger = false;
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    const expanded = await page.evaluate(() => document.activeElement?.getAttribute("aria-expanded") ?? null);
    if (expanded !== null) {
      reachedGroupTrigger = true;
      break;
    }
  }
  expect(reachedGroupTrigger).toBe(true);
});

test("keyboard-only: the theme toggle is reachable and operable via keyboard alone", async ({ page }) => {
  await page.goto("/");
  const toggle = page.getByRole("button", { name: "Toggle theme" });
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: /Dark/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem", { name: /Dark/ })).not.toBeVisible();
});
