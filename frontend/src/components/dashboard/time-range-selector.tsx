"use client";

import { cn } from "@/lib/utils";
import { TIME_RANGES, type TimeRange } from "@/types/dashboard";

const RANGE_LABEL: Record<TimeRange, string> = { "1h": "1h", "6h": "6h", "24h": "24h", "7d": "7d", "30d": "30d" };

export interface TimeRangeSelectorProps {
  value: TimeRange;
  onChange: (range: TimeRange) => void;
}

/** AC: preset range options (1h/6h/24h/7d/30d). Plain button group, not @radix-ui/react-toggle-group — that package isn't installed anywhere in this codebase yet, and pulling it in for one control is more than this WO's own scope needs; a `role="group"` of toggle buttons gives the same keyboard/AT semantics. */
export function TimeRangeSelector({ value, onChange }: TimeRangeSelectorProps) {
  return (
    <div role="group" aria-label="Time range" className="border-border inline-flex rounded-md border">
      {TIME_RANGES.map((range) => (
        <button
          key={range}
          type="button"
          aria-pressed={value === range}
          onClick={() => onChange(range)}
          className={cn("px-3 py-1.5 text-sm first:rounded-l-md last:rounded-r-md", value === range ? "bg-primary text-primary-foreground" : "hover:bg-muted")}
        >
          {RANGE_LABEL[range]}
        </button>
      ))}
    </div>
  );
}
