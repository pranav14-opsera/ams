import { defineConfig, devices } from "@playwright/test";

// AC: "Playwright is configured for E2E testing... targeting the static
// export directory." webServer serves the already-built `out/` directory
// (the same static export the Docker image ships) rather than `next dev`
// — an E2E pass here is evidence the actual production artifact works,
// not just the dev server.
export default defineConfig({
  testDir: "./tests/e2e",
  // `serve` (the static file server backing webServer below) is not
  // built for concurrent load — running multiple Playwright workers
  // against it genuinely dropped connections (net::ERR_ABORTED) during
  // this WO's own verification, not a real app bug. A single worker
  // avoids it entirely; this suite is small enough that serializing it
  // costs a few seconds, not minutes.
  fullyParallel: false,
  workers: 1,
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
