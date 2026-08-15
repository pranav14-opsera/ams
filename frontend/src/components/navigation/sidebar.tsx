"use client";

import type { KeyboardEvent } from "react";
import { Menu, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { NAVIGATION_CONFIG } from "@/config/navigation";
import { usePermissions } from "@/hooks/usePermissions";
import { useSidebarState } from "@/hooks/useSidebarState";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { MobileDrawer } from "./mobile-drawer";
import { SidebarGroup } from "./sidebar-group";

const FOCUSABLE_SELECTOR = "a[href], button:not([disabled])";

/** AC: "Arrow keys navigate within groups." Moves focus among the currently visible/focusable items (group triggers + links) in DOM order — a collapsed group's own children aren't in the DOM at all, so this naturally scopes to whatever is actually expanded. */
function handleArrowNavigation(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const nav = event.currentTarget;
  const focusable = Array.from(nav.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  if (focusable.length === 0) return;

  const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
  const delta = event.key === "ArrowDown" ? 1 : -1;
  const nextIndex = currentIndex === -1 ? 0 : (currentIndex + delta + focusable.length) % focusable.length;

  event.preventDefault();
  focusable[nextIndex]?.focus();
}

function NavigationTree({
  collapsed,
  expandedGroups,
  onToggleGroup,
  onNavigate,
}: {
  collapsed: boolean;
  expandedGroups: Set<string>;
  onToggleGroup: (id: string) => void;
  onNavigate?: () => void;
}) {
  const { filterNavigation } = usePermissions();
  const visibleGroups = filterNavigation(NAVIGATION_CONFIG);

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- WAI-ARIA's own "Managing Focus Within Groups" pattern: a keydown listener on the landmark container implementing roving-tabindex-style arrow navigation for its interactive descendants (the group triggers/links themselves, not the <nav> itself, are what's activated).
    <nav aria-label="Primary" className="flex flex-col gap-1" onKeyDown={handleArrowNavigation}>
      {visibleGroups.map((group) => (
        <SidebarGroup
          key={group.id}
          group={group}
          expanded={expandedGroups.has(group.id)}
          onToggle={() => onToggleGroup(group.id)}
          collapsed={collapsed}
          onNavigate={onNavigate}
        />
      ))}
    </nav>
  );
}

/**
 * The platform's single navigation mechanism (AC: "every subsequent
 * feature page plugs into this navigation structure"). Desktop
 * (>=768px) renders a persistent, collapsible-to-icon-only left panel;
 * mobile (<768px) renders the same tree inside MobileDrawer, triggered by
 * a hamburger button. The skip-to-content link (WO-053's own
 * SkipToContent) now renders at the true root of <body>, before any
 * provider — it no longer needs to live here to be "first."
 */
export function Sidebar() {
  const { isMobile, collapsed, setCollapsed, expandedGroups, toggleGroup, mobileDrawerOpen, openMobileDrawer, closeMobileDrawer } = useSidebarState();

  if (isMobile) {
    return (
      <>
        <div className="m-2 flex items-center gap-1">
          <Button variant="ghost" size="sm" aria-label="Open navigation" onClick={openMobileDrawer}>
            <Menu aria-hidden="true" className="size-5" />
          </Button>
          <ThemeToggle />
        </div>
        <MobileDrawer open={mobileDrawerOpen} onOpenChange={(open) => (open ? openMobileDrawer() : closeMobileDrawer())}>
          <NavigationTree collapsed={false} expandedGroups={expandedGroups} onToggleGroup={toggleGroup} onNavigate={closeMobileDrawer} />
        </MobileDrawer>
      </>
    );
  }

  return (
    <aside aria-label="Sidebar" className={collapsed ? "border-border w-16 shrink-0 border-r p-2" : "border-border w-64 shrink-0 border-r p-4"}>
      <div className={collapsed ? "mb-2 flex flex-col gap-1" : "mb-2 flex items-center gap-1"}>
        <Button
          variant="ghost"
          size="sm"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() => setCollapsed(!collapsed)}
          className={collapsed ? "w-full justify-start" : "flex-1 justify-start"}
        >
          {collapsed ? <PanelLeftOpen aria-hidden="true" className="size-4" /> : <PanelLeftClose aria-hidden="true" className="size-4" />}
        </Button>
        <ThemeToggle />
      </div>
      <NavigationTree collapsed={collapsed} expandedGroups={expandedGroups} onToggleGroup={toggleGroup} />
    </aside>
  );
}
