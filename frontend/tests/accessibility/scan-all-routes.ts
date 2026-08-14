import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { discoverRoutes } from "./discover-routes";
import { WCAG_TAGS, BLOCKING_IMPACTS, WARNING_IMPACTS, VIEWPORTS } from "./axe-config";

const BASE_URL = process.env.SCAN_BASE_URL ?? "http://localhost:4173";
const REPORT_PATH = process.env.SCAN_REPORT_PATH ?? join(__dirname, "..", "..", "axe-report.json");

async function main() {
  const routes = discoverRoutes();
  if (routes.length === 0) {
    throw new Error("No routes discovered under app/ — nothing to scan.");
  }

  const browser = await chromium.launch();
  const results: Array<{
    route: string;
    viewport: string;
    violations: Array<{
      id: string;
      impact: string | null | undefined;
      help: string;
      helpUrl: string;
      nodes: Array<{ target: string[]; failureSummary?: string }>;
    }>;
  }> = [];

  try {
    for (const route of routes) {
      for (const viewport of VIEWPORTS) {
        const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
        const page = await context.newPage();
        try {
          await page.goto(`${BASE_URL}${route}`, { waitUntil: "networkidle" });
          const axeResults = await new AxeBuilder({ page }).withTags([...WCAG_TAGS]).analyze();
          results.push({
            route,
            viewport: viewport.name,
            violations: axeResults.violations.map((v) => ({
              id: v.id,
              impact: v.impact,
              help: v.help,
              helpUrl: v.helpUrl,
              nodes: v.nodes.map((n) => ({ target: n.target as string[], failureSummary: n.failureSummary })),
            })),
          });
        } finally {
          await context.close();
        }
      }
    }
  } finally {
    await browser.close();
  }

  const critical = results.flatMap((r) =>
    r.violations
      .filter((v) => BLOCKING_IMPACTS.includes(v.impact as (typeof BLOCKING_IMPACTS)[number]))
      .map((v) => ({ ...v, route: r.route, viewport: r.viewport })),
  );
  const serious = results.flatMap((r) =>
    r.violations
      .filter((v) => WARNING_IMPACTS.includes(v.impact as (typeof WARNING_IMPACTS)[number]))
      .map((v) => ({ ...v, route: r.route, viewport: r.viewport })),
  );

  const report = {
    scannedAt: new Date().toISOString(),
    routes,
    viewports: VIEWPORTS.map((v) => v.name),
    summary: { critical: critical.length, serious: serious.length, total: results.flatMap((r) => r.violations).length },
    critical,
    serious,
    all: results,
  };
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  console.log(`Scanned ${routes.length} route(s) x ${VIEWPORTS.length} viewport(s).`);
  console.log(`Critical: ${critical.length}, Serious (warning only): ${serious.length}`);

  if (critical.length > 0) {
    for (const v of critical) {
      console.error(`\n[CRITICAL] ${v.id} on ${v.route} (${v.viewport}): ${v.help}\n  ${v.helpUrl}`);
      for (const node of v.nodes) console.error(`  - ${node.target.join(" ")}: ${node.failureSummary ?? ""}`);
    }
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
