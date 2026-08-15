import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Folder, Home } from "lucide-react";
import type { NavigationItem } from "@/types/navigation";
import { SidebarGroup } from "./sidebar-group";

vi.mock("next/navigation", () => ({ usePathname: () => "/nowhere" }));

const group: NavigationItem = {
  id: "agent-management",
  label: "Agent Management",
  icon: Folder,
  requiredPermissions: [],
  children: [{ id: "registry", label: "Registry", icon: Home, href: "/agents/registry", requiredPermissions: [] }],
};

describe("SidebarGroup", () => {
  it("reflects the expanded prop via aria-expanded", () => {
    render(<SidebarGroup group={group} expanded={false} onToggle={() => undefined} />);
    expect(screen.getByRole("button", { name: "Agent Management" })).toHaveAttribute("aria-expanded", "false");
  });

  it("calls onToggle when the trigger is clicked", async () => {
    const onToggle = vi.fn();
    render(<SidebarGroup group={group} expanded={false} onToggle={onToggle} />);
    await userEvent.click(screen.getByRole("button", { name: "Agent Management" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("renders children only inside the Collapsible.Content when expanded", () => {
    render(<SidebarGroup group={group} expanded onToggle={() => undefined} />);
    expect(screen.getByRole("link", { name: "Registry" })).toBeInTheDocument();
  });

  it("in collapsed (icon-only) mode, renders a flat icon rail with no expand/collapse trigger", () => {
    render(<SidebarGroup group={group} expanded={false} onToggle={() => undefined} collapsed />);
    expect(screen.queryByRole("button", { name: "Agent Management" })).not.toBeInTheDocument();
    expect(screen.getByRole("link")).toBeInTheDocument();
  });
});
