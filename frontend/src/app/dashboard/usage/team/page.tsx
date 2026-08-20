"use client";

import { useMemo, useState } from "react";
import { AgentComparisonChart } from "@/components/dashboard/agent-comparison-chart";
import { TeamConsumptionTrendChart } from "@/components/dashboard/team-consumption-trend-chart";
import { TeamSelector } from "@/components/dashboard/team-selector";
import { TeamUsageKPICards } from "@/components/dashboard/team-usage-kpi-cards";
import { UsageFilterPanel } from "@/components/dashboard/usage-filter-panel";
import { useSelectableTeamsQuery, useTeamUsageQuery } from "@/hooks/useTeamUsageQuery";
import { useTeamUsageSubscription } from "@/hooks/useTeamUsageSubscription";
import type { TeamUsageFilters, TeamUsagePeriod, TeamUsageSummary } from "@/types/dashboard";

// No backend endpoint enumerates a tenant's actual distinct
// credit_transactions.action_type values (it's a free-text column, see
// credit_rate_mappings' own per-tenant-configurable rate table — there is
// no fixed platform-wide enum to source this list from). These two are
// the only action types this codebase's own real write paths ever
// record (MeteringEngineService/CreditTransactionRepository call sites)
// — documented as a known gap in this WO's own reconciliation doc rather
// than silently hard-coding a fuller list that would look complete but
// isn't actually backed by real data.
const KNOWN_ACTION_TYPES = ["agent_execution", "tool_call"];

/**
 * AC: the team-scoped usage analytics dashboard — team KPIs, a filter
 * panel (agent/action type/framework/date range), an agent comparison
 * chart with a 2x-team-average visual indicator, and (for a Platform
 * Administrator only) a team selector. Same "REST paints the first
 * frame, WebSocket keeps the KPIs live" split WO-074's own org dashboard
 * uses — the trend/comparison detail always comes from the REST query
 * (it reflects whatever filters are applied, which the lightweight
 * WebSocket delta never carries), while the KPI cards' balance/burn-rate
 * merge in whatever the socket most recently delivered FOR THIS team.
 */
export default function TeamUsageDashboardPage() {
  const [selectedTeamId, setSelectedTeamId] = useState<string | undefined>(undefined);
  const [period, setPeriod] = useState<TeamUsagePeriod>("30d");
  const [filters, setFilters] = useState<TeamUsageFilters>({});

  const teamsQuery = useSelectableTeamsQuery();
  const query = useTeamUsageQuery(period, "daily", selectedTeamId, filters);
  const { latest: liveUpdate, connectionState, isStale } = useTeamUsageSubscription(query.data?.team.id);

  const merged: TeamUsageSummary | undefined = useMemo(() => {
    if (!query.data) return undefined;
    if (!liveUpdate) return query.data;
    return { ...query.data, balance: liveUpdate.balance, burnRate: liveUpdate.burnRate };
  }, [query.data, liveUpdate]);

  if (query.isLoading && !merged) {
    return <p role="status">Loading team usage…</p>;
  }

  if (query.isError && !merged) {
    return <p role="alert">Unable to load the team usage dashboard right now. Please try again shortly.</p>;
  }

  if (!merged) {
    // edge_case: "Admin with no teams in the tenant" — the service's own resolveTeamId throws NotFoundException for this, surfaced here as a guidance empty state rather than a raw error.
    return (
      <p className="text-muted-foreground text-sm" role="status">
        No teams are configured for this organization yet. Once a team is created, its usage will appear here.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-xl font-semibold">{merged.team.name} — Usage</h2>
        <div className="flex items-center gap-4">
          <TeamSelector teams={teamsQuery.data ?? []} selectedTeamId={merged.team.id} onChange={setSelectedTeamId} />
          <p className="text-muted-foreground text-sm" role="status">
            {connectionState === "connected" ? "Live" : connectionState === "reconnecting" ? "Connection lost — reconnecting…" : "Offline"}
            {isStale ? " · data may be out of date" : ""}
            {merged.servedFromCache ? " · showing last known snapshot" : ""}
          </p>
        </div>
      </div>

      <UsageFilterPanel
        agents={merged.agentComparison}
        actionTypes={KNOWN_ACTION_TYPES}
        period={period}
        filters={filters}
        onPeriodChange={setPeriod}
        onFiltersChange={setFilters}
        onReset={() => setFilters({})}
      />

      <TeamUsageKPICards summary={merged} />
      <TeamConsumptionTrendChart points={merged.consumptionTrend} />
      <AgentComparisonChart agents={merged.agentComparison} />
    </div>
  );
}
