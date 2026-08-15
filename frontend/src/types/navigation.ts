import type { ComponentType, SVGProps } from "react";

export type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

export interface NavigationItem {
  id: string;
  label: string;
  icon: IconComponent;
  /** Group headers (e.g. "Agent Management") are non-navigable — undefined href, only children. */
  href?: string;
  /**
   * The user must hold AT LEAST ONE of these to see this item (OR
   * semantics — matches RbacGuard's own @RequireAnyPermission shape for
   * routes shared by multiple roles). A group header's own array is
   * typically empty — group visibility is derived from whether ANY child
   * survives filtering, not from a permission of its own.
   */
  requiredPermissions: string[];
  children?: NavigationItem[];
  badge?: number;
}
