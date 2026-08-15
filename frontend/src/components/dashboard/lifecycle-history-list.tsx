import type { LifecycleHistoryEntry } from "@/types/dashboard";

/** AC: agent lifecycle history — all state transitions with timestamps and actors. */
export function LifecycleHistoryList({ entries }: { entries: LifecycleHistoryEntry[] }) {
  if (entries.length === 0) {
    return (
      <p className="text-muted-foreground text-sm" role="status">
        No lifecycle transitions recorded.
      </p>
    );
  }

  return (
    <ol className="flex flex-col gap-2" aria-label="Lifecycle history">
      {entries.map((entry, index) => (
        <li key={index} className="flex items-center justify-between gap-2 text-sm">
          <span>
            <span className="font-medium">{entry.fromStatus}</span> → <span className="font-medium">{entry.toStatus}</span>
            {entry.reason ? ` — ${entry.reason}` : ""}
          </span>
          <span className="text-muted-foreground whitespace-nowrap">
            {new Date(entry.occurredAt).toLocaleString()}
            {entry.triggeredBy ? ` · ${entry.triggeredBy}` : ""}
          </span>
        </li>
      ))}
    </ol>
  );
}
