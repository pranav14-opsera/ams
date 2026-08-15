import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "./app-store";

describe("useAppStore", () => {
  beforeEach(() => {
    useAppStore.setState({
      auth: { userId: null, tenantId: null, roles: [], permissions: [], token: null },
      themePreference: "system",
      sidebarOpen: true,
    });
  });

  it("initializes with an empty auth context, system theme, and an open sidebar", () => {
    const state = useAppStore.getState();
    expect(state.auth).toEqual({ userId: null, tenantId: null, roles: [], permissions: [], token: null });
    expect(state.themePreference).toBe("system");
    expect(state.sidebarOpen).toBe(true);
  });

  it("setAuth replaces the auth context, and clearAuth resets it", () => {
    useAppStore.getState().setAuth({ userId: "u1", tenantId: "t1", roles: ["platform_admin"], permissions: ["x"], token: "jwt-abc" });
    expect(useAppStore.getState().auth).toEqual({ userId: "u1", tenantId: "t1", roles: ["platform_admin"], permissions: ["x"], token: "jwt-abc" });

    useAppStore.getState().clearAuth();
    expect(useAppStore.getState().auth).toEqual({ userId: null, tenantId: null, roles: [], permissions: [], token: null });
  });

  it("toggleSidebar flips sidebarOpen, and setSidebarOpen sets it directly", () => {
    useAppStore.getState().toggleSidebar();
    expect(useAppStore.getState().sidebarOpen).toBe(false);

    useAppStore.getState().setSidebarOpen(true);
    expect(useAppStore.getState().sidebarOpen).toBe(true);
  });
});
