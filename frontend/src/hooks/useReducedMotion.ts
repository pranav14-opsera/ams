"use client";

import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function getInitial(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia(QUERY).matches;
}

/** Reactively tracks the OS-level prefers-reduced-motion setting — for the rare case a component needs to branch in JS (e.g. skip a JS-driven animation library, not just a CSS transition), on top of the blanket CSS rule in globals.css that already disables transitions/animations globally. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(getInitial);

  useEffect(() => {
    const mediaQueryList = window.matchMedia(QUERY);
    // Resync (the lazy initializer above only ever runs once) — a
    // genuine external-system read, not a derived-value antipattern.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReduced(mediaQueryList.matches);

    const listener = (event: MediaQueryListEvent) => setReduced(event.matches);
    mediaQueryList.addEventListener("change", listener);
    return () => mediaQueryList.removeEventListener("change", listener);
  }, []);

  return reduced;
}
