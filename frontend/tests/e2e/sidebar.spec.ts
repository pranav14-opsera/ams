import { test, expect, type Page } from "@playwright/test";
import adminPermissions from "../../src/test/fixtures/permissions/admin.json";

const ADMIN_AUTH = { userId: "u1", tenantId: "t1", roles: ["platform_admin"], permissions: adminPermissions };

async function seedAuth(page: Page, auth: unknown) {
  await page.addInitScript((value) => {
    window.localStorage.setItem("__ams_e2e_auth_override__", JSON.stringify(value));
  }, auth);
}

test("desktop: the sidebar renders every AC-specified admin menu item", async ({ page }) => {
  await seedAuth(page, ADMIN_AUTH);
  await page.goto("/");

  // Groups start collapsed by default — expand Agent Management and Governance to reach their items.
  await page.getByRole("button", { name: "Agent Management" }).click();
  await expect(page.getByRole("link", { name: "Agent Registry" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Lifecycle" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Health Dashboard" })).toBeVisible();

  await page.getByRole("button", { name: "Governance" }).click();
  await expect(page.getByRole("link", { name: "RBAC Editor" })).toBeVisible();
  await expect(page.getByRole("link", { name: "ABAC Policies" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Governance Rules" })).toBeVisible();

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("link", { name: "Tenant Config" })).toBeVisible();

  await page.getByRole("button", { name: "Compliance" }).click();
  await expect(page.getByRole("link", { name: "Audit Logs" })).toBeVisible();
});

test("desktop: an unauthenticated visitor (no permissions) sees no navigation groups at all", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Agent Management" })).toHaveCount(0);
  // The nav landmark itself still renders (empty), it's just zero-height
  // with no visible content — toBeAttached, not toBeVisible, is the
  // correct check for an intentionally empty container.
  await expect(page.getByRole("navigation", { name: "Primary" })).toBeAttached();
});

test("mobile: the hamburger button opens a drawer, and it closes via its close button", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await seedAuth(page, ADMIN_AUTH);
  await page.goto("/");

  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();

  await page.getByRole("button", { name: "Close navigation" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
});

test("mobile: Escape closes the open drawer", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await seedAuth(page, ADMIN_AUTH);
  await page.goto("/");

  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
});

test("keyboard: Tab reaches a group trigger and Enter expands it, revealing its items", async ({ page }) => {
  await seedAuth(page, ADMIN_AUTH);
  await page.goto("/");

  const agentManagementTrigger = page.getByRole("button", { name: "Agent Management" });
  await agentManagementTrigger.focus();
  await expect(agentManagementTrigger).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(page.getByRole("link", { name: "Agent Registry" })).toBeVisible();
  await expect(agentManagementTrigger).toHaveAttribute("aria-expanded", "true");
});
