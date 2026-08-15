# Accessibility Infrastructure (WO-053)

Shared utilities every component should build on — this WO is the infrastructure, not any one component's accessibility (that's each component's own responsibility).

## Utilities

- **`SkipToContent`** (`src/components/a11y/skip-to-content.tsx`) — first child of `<body>` (layout.tsx), before any provider. Jumps to `#main-content`.
- **`LiveRegionAnnouncer` / `useAnnounce()`** (`src/components/a11y/live-region-announcer.tsx`, `src/hooks/useAnnounce.ts`) — wraps the app (layout.tsx). `announce(message, "polite" | "assertive")`. Polite is debounced 100ms; assertive is immediate. `useAnnounce()` throws if used outside the provider.
- **`FocusTrap`** (`src/components/a11y/focus-trap.tsx`) — thin wrapper over `@radix-ui/react-focus-scope` for custom overlay UI not already built on Radix Dialog/AlertDialog (which already trap focus themselves — don't double-wrap those).
- **`useKeyboardShortcuts(map, enabled?)`** (`src/hooks/useKeyboardShortcuts.ts`) — registry `Map<"ctrl+k", handler>`. Suppressed while typing in an input/textarea/contenteditable; refuses to fire for reserved browser combos (`ctrl+w`, `ctrl+r`, etc.) even if registered.
- **`useReducedMotion()`** (`src/hooks/useReducedMotion.ts`) — reactive `prefers-reduced-motion` boolean, for JS-driven animation that the blanket CSS rule (below) can't reach.
- **`src/test/a11y/axe-setup.ts`** — shared `axe`/`expectNoA11yViolations(container)` for component tests, same WCAG 2.1 AA standard as the E2E/CI axe-core scans.

## CSS (globals.css)

- `@media (prefers-reduced-motion: reduce)` collapses every transition/animation to 0.01ms (not literally 0 — some tooling needs `transitionend` to still fire).
- `@media (forced-colors: active)` forces a real `outline` on `:focus-visible` — Windows High Contrast Mode ignores `box-shadow`-only focus rings.

## Landmarks

Root layout: `header` (banner) → `Sidebar`'s own `aside` (wrapping its `nav`) → `main#main-content`. `nav`/`aside` already shipped together in WO-051's Sidebar (a "nav rail as aside" structure) — this WO added the missing `header`.

## Testing

Unit tests for every utility above (`*.test.ts(x)` alongside each file). E2E: `tests/e2e/keyboard-navigation.spec.ts` — Tab-only traversal from the skip link through the sidebar with no dead ends; `tests/e2e/theme-toggle.spec.ts` / `sidebar-accessibility.spec.ts` — axe-core scans across every mode this WO's siblings (WO-051/052) introduced.
