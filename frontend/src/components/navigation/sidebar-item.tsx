"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { NavigationItem } from "@/types/navigation";
import { cn } from "@/lib/utils";

export interface SidebarItemProps {
  item: NavigationItem;
  collapsed?: boolean;
  onNavigate?: () => void;
}

/**
 * A single leaf navigation link. The active route is marked with BOTH a
 * background color AND a left border (AC: "not relying on color alone"
 * for WCAG's non-color-indicator requirement), plus `aria-current="page"`
 * so screen readers announce it — `usePathname` needs no server call,
 * this is a pure client-side comparison against the current route.
 */
export function SidebarItem({ item, collapsed = false, onNavigate }: SidebarItemProps) {
  const pathname = usePathname();
  const isActive = item.href !== undefined && pathname === item.href;
  const Icon = item.icon;

  return (
    <Link
      href={item.href ?? "#"}
      aria-current={isActive ? "page" : undefined}
      onClick={onNavigate}
      className={cn(
        "flex items-center gap-3 rounded-md border-l-2 px-3 py-2 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
        isActive ? "border-primary bg-muted text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground border-transparent",
      )}
    >
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      {!collapsed && <span className="truncate">{item.label}</span>}
      {!collapsed && item.badge !== undefined && item.badge > 0 && (
        <span aria-label={`${item.badge} notifications`} className="bg-primary text-primary-foreground ml-auto rounded-full px-1.5 text-xs">
          {item.badge}
        </span>
      )}
    </Link>
  );
}
