import AxeBuilder from "@axe-core/playwright";
import { test, expect, type Page } from "@playwright/test";
import adminPermissions from "../../src/test/fixtures/permissions/admin.json";

const ADMIN_AUTH = { userId: "u1", tenantId: "t1", roles: ["platform_admin"], permissions: adminPermissions };

async function seedAuth(page: Page, auth: unknown) {
  await page.addInitScript((value) => {
    window.localStorage.setItem("__ams_e2e_auth_override__", JSON.stringify(value));
  }, auth);
}

// AC's final implementation step: axe-core across desktop, mobile drawer,
// collapsed, and multiple role configurations, each expected to be
// zero-violation. Separate from tests/accessibility/scan-all-routes.ts
// (WO-009's route-discovery scanner, which only exercises each static
// route in its default un-authenticated state) — these specifically
// stage the sidebar into the exact modes the AC calls out by name.
test.describe("sidebar accessibility (WCAG 2.1 AA)", () => {
  test("desktop, expanded groups, admin role", async ({ page }) => {
    await seedAuth(page, ADMIN_AUTH);
    await page.goto("/");
    await page.getByRole("button", { name: "Agent Management" }).click();
    await page.getByRole("button", { name: "Governance" }).click();

    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(results.violations.filter((v) => v.impact === "critical")).toEqual([]);
  });

  test("desktop, collapsed (icon-only) mode", async ({ page }) => {
    await seedAuth(page, ADMIN_AUTH);
    await page.goto("/");
    await page.getByRole("button", { name: "Collapse sidebar" }).click();

    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(results.violations.filter((v) => v.impact === "critical")).toEqual([]);
  });

  test("mobile drawer open", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await seedAuth(page, ADMIN_AUTH);
    await page.goto("/");
    await page.getByRole("button", { name: "Open navigation" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(results.violations.filter((v) => v.impact === "critical")).toEqual([]);
  });

  test("unauthenticated (empty navigation)", async ({ page }) => {
    await page.goto("/");
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(results.violations.filter((v) => v.impact === "critical")).toEqual([]);
  });
});
