import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const APP_DIR = join(__dirname, "..", "..", "src", "app");

// Walks the Next.js app router tree and returns every static route that has
// a page.tsx. Route groups `(name)` don't appear in the URL; dynamic
// segments `[param]` are skipped — there's no real param value to render
// without seeding one, and a wrong guess would just 404 rather than test
// anything.
export function discoverRoutes(dir: string = APP_DIR, prefix = ""): string[] {
  const routes: string[] = [];
  const entries = readdirSync(dir);

  if (entries.includes("page.tsx") || entries.includes("page.ts")) {
    routes.push(prefix === "" ? "/" : prefix);
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    if (!statSync(fullPath).isDirectory()) continue;
    if (entry.startsWith("[")) continue; // dynamic segment — needs a real param, skip
    if (entry.startsWith("_")) continue; // private folder, not a route

    const segment = entry.startsWith("(") && entry.endsWith(")") ? "" : `/${entry}`;
    routes.push(...discoverRoutes(fullPath, `${prefix}${segment}`));
  }

  return routes;
}
