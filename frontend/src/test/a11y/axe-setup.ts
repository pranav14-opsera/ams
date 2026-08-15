import { configureAxe } from "vitest-axe";

/**
 * AC: "a shared configureAxe function that sets WCAG 2.1 AA as the
 * target standard." Component-level (Vitest+jsdom) axe checks share this
 * one configuration so every test targets the same standard as the E2E
 * (Playwright) axe-core scans and CI's own scan-axe-core stage
 * (WO-009/pipeline.yaml) — one accessibility bar, checked at every layer.
 */
export const axe = configureAxe({
  rules: {
    // jsdom has no real canvas 2D context (WO-050's own
    // AUDIT_RECONCILIATION... no, FRONTEND_SCAFFOLD.md finding) — the same
    // color-contrast limitation already documented for the Button
    // component's own axe test applies here too; the E2E/CI axe-core
    // scans (a real browser) are the authoritative check for contrast.
    "color-contrast": { enabled: false },
  },
});

/** Convenience helper so component tests don't need to know configureAxe's options shape — `await expectNoA11yViolations(container)`. Imports the matcher from vitest-axe/dist/matchers directly, not the package-root "vitest-axe/matchers" subpath — that subpath's own .d.ts re-exports it as a TYPE ONLY even though the matching .js is a real value (a genuine mismatch in this package, 0.1.0 — see src/test/setup.ts's own note on the same issue). */
export async function expectNoA11yViolations(container: Element): Promise<void> {
  const results = await axe(container);
  const { toHaveNoViolations } = await import("vitest-axe/dist/matchers");
  const check = toHaveNoViolations(results);
  if (!check.pass) {
    throw new Error(check.message());
  }
}
