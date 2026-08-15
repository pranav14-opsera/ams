"use client";

import { Menu, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { NAVIGATION_CONFIG } from "@/config/navigation";
import { usePermissions } from "@/hooks/usePermissions";
import { useSidebarState } from "@/hooks/useSidebarState";
import { Button } from "@/components/ui/button";
import { MobileDrawer } from "./mobile-drawer";
import { SidebarGroup } from "./sidebar-group";

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
    <nav aria-label="Primary" className="flex flex-col gap-1">
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
 * a hamburger button. The skip-to-content link is deliberately the very
 * first focusable element in the DOM (AC's own "as the first focusable
 * element" requirement) — it must render before the nav, not inside it.
 */
export function Sidebar() {
  const { isMobile, collapsed, setCollapsed, expandedGroups, toggleGroup, mobileDrawerOpen, openMobileDrawer, closeMobileDrawer } = useSidebarState();

  const skipLink = (
    <a
      href="#main-content"
      className="focus:bg-primary focus:text-primary-foreground sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:px-3 focus:py-2"
    >
      Skip to content
    </a>
  );

  if (isMobile) {
    return (
      <>
        {skipLink}
        <Button variant="ghost" size="sm" aria-label="Open navigation" onClick={openMobileDrawer} className="m-2">
          <Menu aria-hidden="true" className="size-5" />
        </Button>
        <MobileDrawer open={mobileDrawerOpen} onOpenChange={(open) => (open ? openMobileDrawer() : closeMobileDrawer())}>
          <NavigationTree collapsed={false} expandedGroups={expandedGroups} onToggleGroup={toggleGroup} onNavigate={closeMobileDrawer} />
        </MobileDrawer>
      </>
    );
  }

  return (
    <>
      {skipLink}
      <aside aria-label="Sidebar" className={collapsed ? "border-border w-16 shrink-0 border-r p-2" : "border-border w-64 shrink-0 border-r p-4"}>
        <Button
          variant="ghost"
          size="sm"
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() => setCollapsed(!collapsed)}
          className="mb-2 w-full justify-start"
        >
          {collapsed ? <PanelLeftOpen aria-hidden="true" className="size-4" /> : <PanelLeftClose aria-hidden="true" className="size-4" />}
        </Button>
        <NavigationTree collapsed={collapsed} expandedGroups={expandedGroups} onToggleGroup={toggleGroup} />
      </aside>
    </>
  );
}
