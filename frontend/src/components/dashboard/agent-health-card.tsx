"use client";

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
export function AgentHealthCard({ agent, onSelect }: AgentHealthCardProps) {
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
