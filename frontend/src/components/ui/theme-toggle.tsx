"use client";

import { Check, Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

const THEME_OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const;

/**
 * AC: a toggle in the sidebar header cycling light/dark/system, with
 * immediate visual feedback and no FOUC. `mounted` guards against
 * rendering the wrong icon during the one render before next-themes has
 * read localStorage on the client — next-themes itself (via
 * suppressHydrationWarning on <html>, set in layout.tsx) already prevents
 * the FOUC of the wrong THEME; this guard is only about the toggle
 * button's OWN icon not flashing light-then-dark on first paint.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // next-themes' own documented hydration-guard pattern: `mounted` is
  // false on the very first client render (matching the pre-hydration
  // markup) and true from then on — there is no lazy-initializer
  // equivalent for "has this component committed at least once yet."
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), []);

  const current = mounted ? theme : undefined;
  const CurrentIcon = THEME_OPTIONS.find((o) => o.value === current)?.icon ?? Monitor;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" aria-label="Toggle theme">
          <CurrentIcon aria-hidden="true" className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {THEME_OPTIONS.map(({ value, label, icon: Icon }) => (
          <DropdownMenuItem key={value} onSelect={() => setTheme(value)}>
            <Icon aria-hidden="true" className="size-4" />
            <span>{label}</span>
            {current === value && <Check aria-label="current theme" className="ml-auto size-4" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
