import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", {
  variants: {
    variant: {
      neutral: "bg-muted text-foreground",
      // Semantic status colors (AC: red for error, amber for degraded) —
      // paired text colors kept dark-on-light for contrast regardless of
      // theme, same reasoning as connection-status-indicator's own dot.
      active: "bg-green-100 text-green-800",
      degraded: "bg-amber-100 text-amber-800",
      error: "bg-red-100 text-red-800",
      paused: "bg-yellow-100 text-yellow-800",
      retired: "bg-gray-200 text-gray-700",
    },
  },
  defaultVariants: {
    variant: "neutral",
  },
});

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
