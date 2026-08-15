"use client";

import * as Collapsible from "@radix-ui/react-collapsible";
import { ChevronRight } from "lucide-react";
import type { NavigationItem } from "@/types/navigation";
import { cn } from "@/lib/utils";
import { SidebarItem } from "./sidebar-item";

export interface SidebarGroupProps {
  group: NavigationItem;
  expanded: boolean;
  onToggle: () => void;
  collapsed?: boolean;
  onNavigate?: () => void;
}

/**
 * A collapsible group header (e.g. "Agent Management") with its children
 * rendered underneath. AC: animated height transition, aria-expanded,
 * chevron rotation, expanded state persisted across route changes (the
 * `expanded` prop and `onToggle` come from useSidebarState, which
 * persists to localStorage — this component itself holds no state).
 */
export function SidebarGroup({ group, expanded, onToggle, collapsed = false, onNavigate }: SidebarGroupProps) {
  const Icon = group.icon;

  if (collapsed) {
    // Icon-only desktop mode: groups render as a flat icon rail, no expand/collapse chrome.
    return (
      <div className="flex flex-col gap-1">
        {group.children?.map((child) => (
          <SidebarItem key={child.id} item={child} collapsed onNavigate={onNavigate} />
        ))}
      </div>
    );
  }

  return (
    <Collapsible.Root open={expanded} onOpenChange={onToggle}>
      <Collapsible.Trigger
        className="text-muted-foreground hover:bg-muted hover:text-foreground flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        aria-expanded={expanded}
      >
        <Icon aria-hidden="true" className="size-4 shrink-0" />
        <span className="truncate">{group.label}</span>
        <ChevronRight aria-hidden="true" className={cn("ml-auto size-4 shrink-0 transition-transform duration-200", expanded && "rotate-90")} />
      </Collapsible.Trigger>
      <Collapsible.Content className="overflow-hidden pl-4 data-[state=closed]:animate-[collapsible-up_200ms_ease-out] data-[state=open]:animate-[collapsible-down_200ms_ease-out]">
        <div className="flex flex-col gap-1 py-1">
          {group.children?.map((child) => (
            <SidebarItem key={child.id} item={child} onNavigate={onNavigate} />
          ))}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
