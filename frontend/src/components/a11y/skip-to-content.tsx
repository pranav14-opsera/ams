/**
 * AC: "the first focusable element on every page, visually hidden until
 * focused, jumps focus to the main content area." Deliberately a plain,
 * hook-free component — it must be able to render before any provider
 * (ThemeProvider/QueryProvider/LiveRegionAnnouncer) in the tree, as the
 * literal first child of <body>, so it's reachable by a single Tab press
 * regardless of what else the app renders.
 */
export function SkipToContent() {
  return (
    <a
      href="#main-content"
      className="focus:bg-primary focus:text-primary-foreground sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:px-3 focus:py-2"
    >
      Skip to content
    </a>
  );
}
