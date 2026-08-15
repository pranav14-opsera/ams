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

export const useAppStore = create<AppState>((set) => ({
  auth: initialAuthState,
  themePreference: "system",
  sidebarOpen: true,
  setAuth: (auth) => set({ auth }),
  clearAuth: () => set({ auth: initialAuthState }),
  setThemePreference: (themePreference) => set({ themePreference }),
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
}));
