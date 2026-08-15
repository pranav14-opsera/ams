"use client";

import { memo } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { AgentHealthViewModel } from "@/types/dashboard";

const STATUS_LABEL: Record<AgentHealthViewModel["status"], string> = {
  active: "Active",
  paused: "Paused",
  degraded: "Degraded",
  error: "Error",
  retired: "Retired",
};

function formatMetric(value: number | null, suffix: string): string {
  return value === null ? "—" : `${value}${suffix}`;
}

export interface AgentHealthCardProps {
  agent: AgentHealthViewModel;
  onSelect?: (agentId: string) => void;
}

/** AC: semantic color coding for status, click-to-drill-down. Sparkline trend is a follow-up (WO-057's own drill-down scope per the traceability notes) — this card surfaces the current snapshot, not a time series. */
function AgentHealthCardImpl({ agent, onSelect }: AgentHealthCardProps) {
  return (
    <Card
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onClick={onSelect ? () => onSelect(agent.id) : undefined}
      onKeyDown={
        onSelect
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(agent.id);
              }
            }
          : undefined
      }
      className={onSelect ? "cursor-pointer" : undefined}
    >
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle>{agent.name}</CardTitle>
        <Badge variant={agent.status}>{STATUS_LABEL[agent.status]}</Badge>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <div>
          <p className="text-muted-foreground">Framework</p>
          <p>{agent.framework}</p>
        </div>
        <div>
          <p className="text-muted-foreground">P50 / P99 latency</p>
          <p>
            {formatMetric(agent.latencyP50Ms, "ms")} / {formatMetric(agent.latencyP99Ms, "ms")}
          </p>
        </div>
        <div>
          <p className="text-muted-foreground">Error rate</p>
          <p>{agent.errorRateAvg === null ? "—" : `${Math.round(agent.errorRateAvg * 1000) / 10}%`}</p>
        </div>
        <div>
          <p className="text-muted-foreground">Tokens</p>
          <p>{formatMetric(agent.tokenConsumptionTotal, "")}</p>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * WO-058: at 500+ agents, re-rendering every card on every fleet update
 * (even ones whose own data didn't change) is exactly the kind of
 * excessive-re-render cost this WO's AC calls out. Comparing only the
 * fields actually rendered — not reference equality on `agent` or
 * `onSelect` — means a card only re-renders when ITS OWN displayed data
 * changed, regardless of how many sibling cards' data changed in the
 * same batched update, or whether the parent passed a fresh onSelect
 * closure this render (it does, on every render — comparing its
 * reference would defeat the whole point of memoizing).
 */
function arePropsEqual(prev: AgentHealthCardProps, next: AgentHealthCardProps): boolean {
  return (
    prev.agent.id === next.agent.id &&
    prev.agent.name === next.agent.name &&
    prev.agent.framework === next.agent.framework &&
    prev.agent.status === next.agent.status &&
    prev.agent.latencyP50Ms === next.agent.latencyP50Ms &&
    prev.agent.latencyP99Ms === next.agent.latencyP99Ms &&
    prev.agent.errorRateAvg === next.agent.errorRateAvg &&
    prev.agent.tokenConsumptionTotal === next.agent.tokenConsumptionTotal &&
    prev.agent.toolCallSuccessRateAvg === next.agent.toolCallSuccessRateAvg &&
    Boolean(prev.onSelect) === Boolean(next.onSelect)
  );
}

export const AgentHealthCard = memo(AgentHealthCardImpl, arePropsEqual);
