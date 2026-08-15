import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "@playwright/test";

test("system theme is applied by default (no .dark class when OS prefers light)", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await expect(page.locator("html")).not.toHaveClass(/dark/);
});

test("system dark preference is honored by default", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveClass(/dark/);
});

test("toggling to Dark applies the .dark class, and it survives a reload", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");

  await page.getByRole("button", { name: "Toggle theme" }).click();
  await page.getByRole("menuitem", { name: /Dark/ }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);

  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
});

test("toggling back to Light removes the .dark class", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");

  await page.getByRole("button", { name: "Toggle theme" }).click();
  await page.getByRole("menuitem", { name: /Dark/ }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);

  await page.getByRole("button", { name: "Toggle theme" }).click();
  await page.getByRole("menuitem", { name: /Light/ }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
});

test.describe("axe-core: zero contrast/WCAG violations in each theme", () => {
  test("light mode", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(results.violations.filter((v) => v.impact === "critical" || v.impact === "serious")).toEqual([]);
  });

  test("dark mode", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    await page.getByRole("button", { name: "Toggle theme" }).click();
    await page.getByRole("menuitem", { name: /Dark/ }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);

    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(results.violations.filter((v) => v.impact === "critical" || v.impact === "serious")).toEqual([]);
  });
});
