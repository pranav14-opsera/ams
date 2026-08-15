# Dark Mode Theme Toggle (WO-052)

## Architecture

- `src/providers/theme-provider.tsx` — wraps `next-themes`. `disableTransitionOnChange={false}` (WO-050 originally set this `true`, which would suppress the visible 150ms transition this WO's AC asks for). `storageKey` is deliberately left at next-themes' own default (`"theme"`) — this WO's own `implementation_steps` suggested `storageKey="agent-platform-theme"`, which directly contradicts the AC's literal text ("persisted to localStorage under a 'theme' key"). The AC is the pass/fail bar, so it wins; flagging the inconsistency here rather than silently picking one.
- `src/app/globals.css` — the full shadcn/ui semantic token set (background, foreground, card, popover, primary, secondary, muted, accent, destructive, border, input, ring + `-foreground` variants), defined as plain CSS custom properties on `:root` / `.dark`, mapped onto Tailwind v4 color utilities via `@theme inline`.
- `src/components/ui/theme-toggle.tsx` — a `DropdownMenu` (Light/Dark/System) with a `mounted` hydration guard (next-themes' own documented pattern) so the trigger icon itself never flashes the wrong state on first paint.
- `src/test/utils/contrast-check.ts` — a standalone, DOM-free WCAG 2.1 relative-luminance/contrast-ratio calculator operating directly on shadcn's `"H S% L%"` token format.

## A real bug fixed: the original palette never actually responded to the toggle

WO-050's original `globals.css` defined the dark palette **only** inside `@media (prefers-color-scheme: dark)`. `next-themes` (with `attribute="class"`) toggles a real `.dark` class on `<html>` — a media query has no way to know about that class at all. The practical effect: toggling to "Dark" while the OS itself was set to light would have updated `<html class="dark">` correctly, yet **every color token would have stayed in light mode**, because the media query still didn't match. Rewritten as `:root { ... }` / `.dark { ... }` selector-based tokens (mapped through `@theme inline`), which is what actually makes the manual toggle (not just the OS preference) work. Confirmed via the new `theme-toggle.spec.ts` E2E tests, which check the actual rendered `.dark` class and (via axe-core) rendered contrast in both modes — not just that the provider's internal state changed.

## A real bug found via testing: two color pairs failed the AC's own 4.5:1 bar

The AC states plainly: "this must be verified for every color token" — so the palette was **not** simply copied from shadcn's commonly-published Zinc defaults and assumed correct. `contrast-check.test.ts` computes the actual WCAG 2.1 contrast ratio for every background/foreground pair (own relative-luminance implementation, no external library, verified against the spec's own black/white 21:1 and self-contrast 1:1 edge cases) and found two real failures in that commonly-cited default palette:

| Pair (light mode) | Default value | Measured ratio | Fix | Fixed ratio |
|---|---|---|---|---|
| `muted` / `muted-foreground` | `240 3.8% 46.1%` | 4.39:1 (fails 4.5:1) | Darkened to `240 3.8% 42%` | 5.10:1 |
| `destructive` / `destructive-foreground` | `0 84.2% 60.2%` | 3.60:1 (fails 4.5:1) | Darkened to `0 84.2% 45%` | 5.19:1 |

Every other pair (background/foreground, card, popover, primary, secondary, accent, in both light and dark) already passed comfortably; the dark-mode palette had no failures at all. `src/test/fixtures/color-tokens.ts` is the single source of truth the test checks against — it must be kept in sync manually if `globals.css`'s palette values ever change (there's no CSS-parsing step; duplicating typed constants was simpler and more robust for a unit test than parsing the stylesheet).

## Testing

- **Unit**: `contrast-check.test.ts` (parseHsl, relativeLuminance, contrastRatio correctness + all 8 text pairs × 2 modes = 16 AC-mandated checks, all passing), `theme-toggle.test.tsx` (renders/opens/selects each option, `.dark` class add/remove, check-mark on the active option, `localStorage["theme"]` persistence).
- **E2E** (`theme-toggle.spec.ts`): default system-preference honoring (light AND dark emulated OS preference, via Playwright's `emulateMedia`), toggle-to-dark + reload persistence, toggle-back-to-light, and axe-core scans in both themes (0 critical/serious violations in either).
