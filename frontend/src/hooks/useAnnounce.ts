"use client";

import { useContext } from "react";
import { LiveRegionContext, type LiveRegionContextValue } from "@/components/a11y/live-region-announcer";

/** Consumes LiveRegionAnnouncer's context. Throws a descriptive error (AC) rather than silently returning a no-op — a missing provider should fail loudly during development, not swallow every announcement in production. */
export function useAnnounce(): LiveRegionContextValue["announce"] {
  const context = useContext(LiveRegionContext);
  if (!context) {
    throw new Error(
      "useAnnounce() must be used within a <LiveRegionAnnouncer>. Wrap the app (or the relevant subtree) in <LiveRegionAnnouncer> — see src/docs/ACCESSIBILITY.md.",
    );
  }
  return context.announce;
}
