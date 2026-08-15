"use client";

import { createContext, useCallback, useRef, useState, type ReactNode } from "react";

export type AnnouncementPriority = "polite" | "assertive";

export interface LiveRegionContextValue {
  announce: (message: string, priority?: AnnouncementPriority) => void;
}

export const LiveRegionContext = createContext<LiveRegionContextValue | null>(null);

const POLITE_DEBOUNCE_MS = 100;

/**
 * AC: a React context exposing announce(message, priority) via two
 * off-screen aria-live regions. Polite announcements are debounced 100ms
 * (rapid-fire updates — e.g. a live-updating counter — would otherwise
 * flood the screen reader with every intermediate value); assertive
 * announcements (errors, urgent state changes) bypass the debounce and
 * are delivered immediately, since the whole point of "assertive" is
 * interrupting whatever the screen reader is currently saying.
 *
 * Each region is cleared and re-set with a microtask-scheduled update
 * rather than just overwriting the text directly: some screen readers
 * don't re-announce a region whose text content is set to the SAME
 * string twice in a row (e.g. two consecutive "Saved" messages) — an
 * intentional empty-then-set cycle guarantees each call is always heard.
 */
export function LiveRegionAnnouncer({ children }: { children: ReactNode }) {
  const [politeMessage, setPoliteMessage] = useState("");
  const [assertiveMessage, setAssertiveMessage] = useState("");
  const politeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const announce = useCallback((message: string, priority: AnnouncementPriority = "polite") => {
    if (priority === "assertive") {
      setAssertiveMessage("");
      requestAnimationFrame(() => setAssertiveMessage(message));
      return;
    }

    if (politeTimeoutRef.current) clearTimeout(politeTimeoutRef.current);
    politeTimeoutRef.current = setTimeout(() => {
      setPoliteMessage("");
      requestAnimationFrame(() => setPoliteMessage(message));
    }, POLITE_DEBOUNCE_MS);
  }, []);

  return (
    <LiveRegionContext.Provider value={{ announce }}>
      {children}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {politeMessage}
      </div>
      <div aria-live="assertive" aria-atomic="true" className="sr-only">
        {assertiveMessage}
      </div>
    </LiveRegionContext.Provider>
  );
}
