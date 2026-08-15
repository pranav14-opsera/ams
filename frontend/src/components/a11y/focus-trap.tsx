"use client";

import { FocusScope } from "@radix-ui/react-focus-scope";
import type { ReactNode } from "react";

export interface FocusTrapProps {
  children: ReactNode;
  /** Constrains Tab/Shift+Tab cycling within this container while true (AC). */
  trapped?: boolean;
  /** Cycles Tab past the last item back to the first (and Shift+Tab past the first back to the last) rather than letting focus escape the container. */
  loop?: boolean;
  /** Called when the trap mounts and is about to auto-focus its first focusable descendant — call event.preventDefault() to focus something else instead. */
  onMountAutoFocus?: (event: Event) => void;
  /** Called when the trap unmounts and is about to restore focus to whatever had it before — call event.preventDefault() to restore focus somewhere else instead (AC: "restores focus to the trigger element on close" is FocusScope's own default behavior when this is left unhandled). */
  onUnmountAutoFocus?: (event: Event) => void;
}

/**
 * A general-purpose focus trap for any modal/drawer/dialog-shaped UI
 * (Radix's own Dialog/AlertDialog already build this in; this exists for
 * custom overlay components that AREN'T built on those primitives).
 * Thin wrapper over @radix-ui/react-focus-scope, which already
 * implements: Tab cycling constrained to the container, and restoring
 * focus to whatever element had it before the trap mounted once it
 * unmounts — this component's own job is just exposing that behavior
 * with this codebase's naming/prop conventions.
 */
export function FocusTrap({ children, trapped = true, loop = true, onMountAutoFocus, onUnmountAutoFocus }: FocusTrapProps) {
  return (
    <FocusScope trapped={trapped} loop={loop} onMountAutoFocus={onMountAutoFocus} onUnmountAutoFocus={onUnmountAutoFocus} asChild>
      <div>{children}</div>
    </FocusScope>
  );
}
