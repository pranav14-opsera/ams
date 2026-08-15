import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Home } from "lucide-react";
import type { NavigationItem } from "@/types/navigation";
import { SidebarItem } from "./sidebar-item";

const mockUsePathname = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => mockUsePathname(),
}));

const item: NavigationItem = { id: "dashboard", label: "Dashboard", icon: Home, href: "/dashboard", requiredPermissions: [] };

describe("SidebarItem", () => {
  it("marks the active route with aria-current='page' when the pathname matches", () => {
    mockUsePathname.mockReturnValue("/dashboard");
    render(<SidebarItem item={item} />);
    const link = screen.getByRole("link", { name: "Dashboard" });
    expect(link).toHaveAttribute("aria-current", "page");
  });

  it("does not mark a non-active route as current", () => {
    mockUsePathname.mockReturnValue("/somewhere-else");
    render(<SidebarItem item={item} />);
    const link = screen.getByRole("link", { name: "Dashboard" });
    expect(link).not.toHaveAttribute("aria-current");
  });

  it("hides the label text when collapsed but keeps an accessible link", () => {
    mockUsePathname.mockReturnValue("/somewhere-else");
    render(<SidebarItem item={item} collapsed />);
    expect(screen.queryByText("Dashboard")).not.toBeInTheDocument();
    expect(screen.getByRole("link")).toBeInTheDocument();
  });

  it("renders a badge count when present and not collapsed", () => {
    mockUsePathname.mockReturnValue("/somewhere-else");
    render(<SidebarItem item={{ ...item, badge: 3 }} />);
    expect(screen.getByLabelText("3 notifications")).toBeInTheDocument();
  });
});
