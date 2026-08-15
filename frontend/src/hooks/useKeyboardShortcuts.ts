"use client";

import { useEffect } from "react";

export type ShortcutHandler = (event: KeyboardEvent) => void;

/** Registry key format: modifiers joined with "+", lowercase, in a fixed order — e.g. "ctrl+k", "ctrl+shift+p", "escape", "?". */
export type ShortcutMap = Map<string, ShortcutHandler>;

const INPUT_TAG_NAMES = new Set(["INPUT", "TEXTAREA", "SELECT"]);

function isTypingContext(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (INPUT_TAG_NAMES.has(target.tagName)) return true;
  return target.isContentEditable;
}

function normalizeCombo(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push("ctrl");
  if (event.metaKey) parts.push("meta");
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");

  const key = event.key.toLowerCase();
  // A bare modifier key press (e.g. just pressing Shift) isn't itself a combo.
  if (!["control", "meta", "alt", "shift"].includes(key)) parts.push(key);

  return parts.join("+");
}

// Native browser shortcuts this hook must never shadow, even if a caller
// mistakenly registers one of these combos — e.g. a badly-configured
// shortcut map should not be able to hijack "reload the page."
const RESERVED_COMBOS = new Set(["ctrl+w", "meta+w", "ctrl+t", "meta+t", "ctrl+n", "meta+n", "ctrl+r", "meta+r", "f5", "f11", "f12"]);

/**
 * AC: a registry-pattern global keyboard shortcut hook. Suppresses
 * handling while the user is typing in a form field (checked via
 * isTypingContext) so a shortcut like "s" for "save" doesn't fire on
 * every keystroke while someone is filling out a text input, and refuses
 * to override RESERVED_COMBOS so a shortcut map can never accidentally
 * (or maliciously) hijack a native browser shortcut.
 */
export function useKeyboardShortcuts(shortcuts: ShortcutMap, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (isTypingContext(event.target)) return;

      const combo = normalizeCombo(event);
      if (RESERVED_COMBOS.has(combo)) return;

      const handler = shortcuts.get(combo);
      if (handler) {
        event.preventDefault();
        handler(event);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [shortcuts, enabled]);
}
