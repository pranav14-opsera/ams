"use client";

import { useEffect } from "react";

const DEFAULT_MESSAGE = "You have unsaved changes. Are you sure you want to leave?";

/**
 * AC/edge_case: "Browser back button during wizard: intercept navigation
 * with a confirmation dialog." Covers three distinct ways a user can
 * leave mid-wizard:
 *  1. Tab close / reload / typed-URL navigation — the standard
 *     `beforeunload` prompt (browser-controlled wording, not this
 *     hook's `message`).
 *  2. Browser Back/Forward button — App Router has no Pages-Router-style
 *     `router.events`/`beforePopState` route-change hook to lean on, so
 *     this pushes a sentinel history entry and intercepts the resulting
 *     `popstate`, same technique this class of problem is solved with in
 *     any App Router app.
 *  3. An in-app `<Link>`/`<a>` click to another route (e.g. the top nav)
 *     — intercepted at the document level, since there's no per-Link hook
 *     to hang this off of either.
 */
export function useUnsavedChangesWarning(hasUnsavedChanges: boolean, message: string = DEFAULT_MESSAGE): void {
  useEffect(() => {
    function handleBeforeUnload(e: BeforeUnloadEvent) {
      if (!hasUnsavedChanges) return;
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsavedChanges]);

  useEffect(() => {
    if (!hasUnsavedChanges) return;

    window.history.pushState(null, "", window.location.href);

    function handlePopState() {
      const confirmed = window.confirm(message);
      if (confirmed) {
        window.removeEventListener("popstate", handlePopState);
        window.history.back();
      } else {
        window.history.pushState(null, "", window.location.href);
      }
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [hasUnsavedChanges, message]);

  useEffect(() => {
    if (!hasUnsavedChanges) return;

    function handleClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const target = (e.target as HTMLElement | null)?.closest("a[href]");
      if (!target) return;
      const href = target.getAttribute("href");
      if (!href || href.startsWith("#") || target.getAttribute("target") === "_blank") return;
      // Only internal navigation is worth interrupting — an external link
      // (or a download) leaves the SPA's own unsaved-data question moot.
      let url: URL;
      try {
        url = new URL(href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname) return;

      if (!window.confirm(message)) {
        e.preventDefault();
        e.stopPropagation();
      }
    }

    document.addEventListener("click", handleClick, true);
    return () => document.removeEventListener("click", handleClick, true);
  }, [hasUnsavedChanges, message]);
}
