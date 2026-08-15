"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";

export interface MobileDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

/**
 * The mobile (<768px) navigation drawer. Built directly on Radix's Dialog
 * primitive (the same one shadcn/ui's own "Sheet" component wraps) rather
 * than installing shadcn's Sheet separately — this WO's own AC asks for
 * exactly Dialog's built-in guarantees: focus trapped within the panel
 * while open, closes on overlay click, closes on Escape (all Radix Dialog
 * defaults), plus a visible, labeled close button.
 */
export function MobileDrawer({ open, onOpenChange, children }: MobileDrawerProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content
          aria-label="Primary navigation"
          className="bg-background fixed inset-y-0 left-0 z-50 flex w-72 flex-col p-4 shadow-lg focus:outline-none"
        >
          <Dialog.Title className="sr-only">Navigation</Dialog.Title>
          <Dialog.Close
            aria-label="Close navigation"
            className="text-muted-foreground hover:bg-muted hover:text-foreground self-end rounded-md p-1.5 focus-visible:ring-2 focus-visible:outline-none"
          >
            <X aria-hidden="true" className="size-4" />
          </Dialog.Close>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
