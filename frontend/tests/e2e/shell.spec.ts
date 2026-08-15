import { test, expect } from "@playwright/test";

test("the shell page loads and has the expected document title", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Agent Management Service");
});

test("the shell page exposes a main landmark", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("main")).toBeVisible();
});
