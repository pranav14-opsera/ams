"use client";

import { useMemo, useState } from "react";
import { AgentConsumptionBreakdown } from "@/components/dashboard/agent-consumption-breakdown";
import { ConsumptionTrendChart } from "@/components/dashboard/consumption-trend-chart";
import { OrgUsageKPICards } from "@/components/dashboard/org-usage-kpi-cards";
import { useOrgUsageQuery } from "@/hooks/useOrgUsageQuery";
import { useOrgUsageSubscription } from "@/hooks/useOrgUsageSubscription";
import type { OrgUsageSummary, UsagePeriod } from "@/types/dashboard";

/**
 * AC: the organization-wide usage tracking analytics dashboard —
 * five KPI cards, a consumption trend chart, an agent breakdown, all
 * refreshing within 30 seconds via WebSocket push. Same "REST paints the
 * first frame, the live WebSocket snapshot takes over once connected"
 * pattern as AgentHealthDashboardPage (WO-056): the live push here only
 * carries balance/burn-rate/latest-consumption (api_contracts' own
 * "usage_update" shape is intentionally a lighter delta, not the full
 * trend+breakdown payload — pushing the FULL trend/breakdown on every
 * 100ms-batched update would be needless bandwidth for data that only
 * actually changes on the scale of minutes), so the trend chart and
 * agent breakdown always come from the REST query, while the KPI cards'
 * balance/burn-rate merge in whatever the socket most recently delivered.
 */
export default function OrgUsageDashboardPage() {
  const [period, setPeriod] = useState<UsagePeriod>("30d");
  const query = useOrgUsageQuery(period, "daily");
  const { latest: liveUpdate, connectionState, isStale } = useOrgUsageSubscription();

  const merged: OrgUsageSummary | undefined = useMemo(() => {
    if (!query.data) return undefined;
    if (!liveUpdate) return query.data;
    return { ...query.data, balance: liveUpdate.balance, burnRate: liveUpdate.burnRate };
  }, [query.data, liveUpdate]);

  if (query.isLoading && !merged) {
    return <p role="status">Loading organization usage…</p>;
  }

  if (query.isError && !merged) {
    return <p role="alert">Unable to load the organization usage dashboard right now. Please try again shortly.</p>;
  }

  if (!merged) {
    return <p role="status">No usage data available yet.</p>;
  }

  const isEmptyOrg = merged.agentBreakdown.length === 0 && merged.consumptionTrend.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-xl font-semibold">Organization Usage Overview</h2>
        <p className="text-muted-foreground text-sm" role="status">
          {connectionState === "connected" ? "Live" : connectionState === "reconnecting" ? "Connection lost — reconnecting…" : "Offline"}
          {isStale ? " · data may be out of date" : ""}
          {merged.servedFromCache ? " · showing last known snapshot" : ""}
        </p>
      </div>

      {isEmptyOrg ? (
        // edge_cases: "new tenant with zero consumption history — dashboard must show empty state with helpful onboarding message rather than broken charts."
        <p className="text-muted-foreground text-sm" role="status">
          No usage recorded yet. Once your agents start running, credit consumption, trends, and per-agent breakdowns will appear here.
        </p>
      ) : (
        <>
          <OrgUsageKPICards summary={merged} />
          <ConsumptionTrendChart points={merged.consumptionTrend} period={period} onPeriodChange={setPeriod} />
          <AgentConsumptionBreakdown agents={merged.agentBreakdown} />
        </>
      )}
    </div>
  );
}
