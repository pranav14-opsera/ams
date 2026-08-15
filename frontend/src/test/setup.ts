import "@testing-library/jest-dom/vitest";
import { expect } from "vitest";
// The package-root "vitest-axe/matchers" subpath's .d.ts re-exports this
// as a TYPE ONLY ("export type *"), even though the matching .js is a
// real value export — a genuine mismatch in this package (0.1.0).
// Importing from the dist path directly avoids it.
import { toHaveNoViolations } from "vitest-axe/dist/matchers";

// vitest-axe@0.1.0's own "vitest-axe/extend-expect" entrypoint ships an
// EMPTY compiled file (a real bug in that release — it silently does
// nothing), so `expect(...).toHaveNoViolations()` fails with "Invalid
// Chai property" if only that import is used. Registering the matcher
// directly from "vitest-axe/matchers" (the actual implementation) works
// around it.
expect.extend({ toHaveNoViolations });

// jsdom has no matchMedia implementation — next-themes (ThemeProvider)
// reads it to detect the OS color-scheme preference.
if (typeof window !== "undefined" && !window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  });
}
