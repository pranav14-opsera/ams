import type { NavigationItem } from "@/types/navigation";
import { useAppStore } from "@/stores/app-store";

/**
 * Recursively filters a navigation tree down to only the items the given
 * permission set actually authorizes — an item with an empty
 * requiredPermissions array (a group header) survives ONLY if at least
 * one of its (already-filtered) children survives; a leaf item survives
 * if the caller holds ANY of its requiredPermissions (OR semantics,
 * matching RbacGuard's own @RequireAnyPermission shape).
 *
 * OWASP A01: this removes items from the returned array entirely (never
 * hides them via CSS) — but this is a UX affordance, not the access
 * control. The corresponding routes are, and must remain, independently
 * enforced by the server's own RbacGuard; an unlisted permission here
 * never implies the route itself is safe to expose without that guard.
 */
export function filterNavigationByPermissions(items: NavigationItem[], grantedPermissions: string[]): NavigationItem[] {
  const granted = new Set(grantedPermissions);
  const hasOwnAccess = (item: NavigationItem): boolean => item.requiredPermissions.length === 0 || item.requiredPermissions.some((p) => granted.has(p));

  function filterItem(item: NavigationItem): NavigationItem | null {
    const isGroup = Boolean(item.children && item.children.length > 0);

    if (isGroup) {
      const children = item.children!.map(filterItem).filter((child): child is NavigationItem => child !== null);
      // A group header is visible only if at least one child survived —
      // its own requiredPermissions (always empty by convention) never
      // makes an otherwise-empty group visible.
      if (children.length === 0) return null;
      return { ...item, children };
    }

    // Leaf item: visible only if the caller holds at least one required permission.
    return hasOwnAccess(item) ? item : null;
  }

  return items.map(filterItem).filter((item): item is NavigationItem => item !== null);
}

/** The current user's navigation tree, filtered by their own permissions from the Zustand auth store. */
export function usePermissions() {
  const permissions = useAppStore((state) => state.auth.permissions);
  return { permissions, filterNavigation: (items: NavigationItem[]) => filterNavigationByPermissions(items, permissions) };
}
