"use client";

import { useEffect, useState } from "react";

function getInitialMatch(query: string): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia(query).matches;
}

/** Tracks a CSS media query's match state, updating live as the viewport crosses the breakpoint. The initial value is read via a lazy useState initializer (not inside the effect) — the effect's own job is only to subscribe to subsequent changes, an external system this component doesn't own. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => getInitialMatch(query));

  useEffect(() => {
    const mediaQueryList = window.matchMedia(query);
    // Resyncs if `query` itself changes after mount (the lazy initializer
    // above only ever runs once) — a genuine, intentional external-system
    // sync, not a cascading-render antipattern.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMatches(mediaQueryList.matches);

    const listener = (event: MediaQueryListEvent) => setMatches(event.matches);
    mediaQueryList.addEventListener("change", listener);
    return () => mediaQueryList.removeEventListener("change", listener);
  }, [query]);

  return matches;
}
