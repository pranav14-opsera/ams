"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ReactNode } from "react";

// WO-052: storageKey is deliberately next-themes' own default ("theme"),
// NOT a custom key — the AC explicitly requires "persisted to
// localStorage under a 'theme' key" (this WO's own implementation_steps
// separately suggested storageKey="agent-platform-theme", which would
// contradict that AC; the AC is the pass/fail bar, so it wins).
// disableTransitionOnChange is false (WO-050 originally set it true) —
// the AC wants a visible 150ms color transition on toggle (globals.css),
// and disableTransitionOnChange's whole purpose is to suppress exactly
// that transition during the switch.
export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange={false}>
      {children}
    </NextThemesProvider>
  );
}
