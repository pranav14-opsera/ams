import { create } from "zustand";

export type ThemePreference = "light" | "dark" | "system";

export interface AuthContextState {
  userId: string | null;
  tenantId: string | null;
  roles: string[];
  permissions: string[];
}

export interface AppState {
  auth: AuthContextState;
  themePreference: ThemePreference;
  sidebarOpen: boolean;
  setAuth: (auth: AuthContextState) => void;
  clearAuth: () => void;
  setThemePreference: (theme: ThemePreference) => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
}

const initialAuthState: AuthContextState = {
  userId: null,
  tenantId: null,
  roles: [],
  permissions: [],
};

// E2E-only seam (WO-051): Playwright has no real backend to authenticate
// against, so it seeds this ONE localStorage key via page.addInitScript
// before the app ever loads, letting a test mock "logged in as this role,
// with these permissions" without any window-global exposure or
// NODE_ENV-gated dev code shipping differently between environments. A
// real user session never writes this key — nothing else in the app does.
function readE2eAuthOverride(): AuthContextState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem("__ams_e2e_auth_override__");
    return raw ? (JSON.parse(raw) as AuthContextState) : null;
  } catch {
    return null;
  }
}

export const useAppStore = create<AppState>((set) => ({
  auth: readE2eAuthOverride() ?? initialAuthState,
  themePreference: "system",
  sidebarOpen: true,
  setAuth: (auth) => set({ auth }),
  clearAuth: () => set({ auth: initialAuthState }),
  setThemePreference: (themePreference) => set({ themePreference }),
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
}));
