"use client";

import { useCallback, useEffect, useState } from "react";
import { useMediaQuery } from "@/hooks/useMediaQuery";

const MOBILE_BREAKPOINT_QUERY = "(max-width: 767px)";
const COLLAPSED_STORAGE_KEY = "ams:sidebar:collapsed";
const EXPANDED_GROUPS_STORAGE_KEY = "ams:sidebar:expanded-groups";

function readStoredCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === "true";
}

function readStoredExpandedGroups(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(EXPANDED_GROUPS_STORAGE_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

/**
 * Sidebar responsive/collapse/mobile-drawer state, all persisted to
 * localStorage so expanded groups and collapsed mode survive route
 * changes and reloads (AC: "maintain expanded state across route
 * changes"). isMobile flips the rendering mode between the persistent
 * desktop panel and the drawer overlay at the 768px breakpoint.
 */
export function useSidebarState() {
  const isMobile = useMediaQuery(MOBILE_BREAKPOINT_QUERY);
  // Lazy initializers (run once, on the client, at mount) rather than an
  // effect + setState — there's nothing external to subscribe to here,
  // just a one-time read.
  const [collapsed, setCollapsedState] = useState(readStoredCollapsed);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(readStoredExpandedGroups);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);

  useEffect(() => {
    // The mobile drawer is never "collapsed" — closing it whenever the
    // viewport crosses INTO mobile mode is a genuine resync with an
    // external signal (the media query), not a plain derived value.
    if (isMobile) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMobileDrawerOpen(false);
    }
  }, [isMobile]);

  const setCollapsed = useCallback((value: boolean) => {
    setCollapsedState(value);
    window.localStorage.setItem(COLLAPSED_STORAGE_KEY, String(value));
  }, []);

  const toggleGroup = useCallback((groupId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      window.localStorage.setItem(EXPANDED_GROUPS_STORAGE_KEY, JSON.stringify([...next]));
      return next;
    });
  }, []);

  return {
    isMobile,
    collapsed,
    setCollapsed,
    expandedGroups,
    toggleGroup,
    mobileDrawerOpen,
    openMobileDrawer: () => setMobileDrawerOpen(true),
    closeMobileDrawer: () => setMobileDrawerOpen(false),
  };
}
