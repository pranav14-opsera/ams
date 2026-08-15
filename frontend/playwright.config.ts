import { defineConfig, devices } from "@playwright/test";

// AC: "Playwright is configured for E2E testing... targeting the static
// export directory." webServer serves the already-built `out/` directory
// (the same static export the Docker image ships) rather than `next dev`
// — an E2E pass here is evidence the actual production artifact works,
// not just the dev server.
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [["html", { outputFolder: "playwright-report", open: "never" }]],
  use: {
    baseURL: "http://localhost:4173",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run a11y:serve",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
