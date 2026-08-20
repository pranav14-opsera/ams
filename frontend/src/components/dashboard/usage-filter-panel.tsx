"use client";

import { TEAM_USAGE_FRAMEWORKS, TEAM_USAGE_PERIODS, type TeamAgentComparisonEntry, type TeamUsageFilters, type TeamUsageFramework, type TeamUsagePeriod } from "@/types/dashboard";
import { cn } from "@/lib/utils";

const PERIOD_LABEL: Record<TeamUsagePeriod, string> = { "7d": "7 days", "30d": "30 days", "60d": "60 days", "90d": "90 days" };
const FRAMEWORK_LABEL: Record<TeamUsageFramework, string> = { langchain: "LangChain", crewai: "CrewAI", autogen: "AutoGen", rest: "REST" };

function toggle<T>(list: T[] | undefined, value: T): T[] | undefined {
  const current = list ?? [];
  const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
  return next.length > 0 ? next : undefined;
}

export interface UsageFilterPanelProps {
  agents: Pick<TeamAgentComparisonEntry, "agentId" | "agentName">[];
  /** No backend endpoint enumerates a tenant's distinct credit_transactions.action_type values (it's a free-text column, no fixed platform-wide vocabulary) — the caller supplies whatever known/observed action types it has (see TeamUsageDashboardPage's own KNOWN_ACTION_TYPES). */
  actionTypes: string[];
  period: TeamUsagePeriod;
  filters: TeamUsageFilters;
  onPeriodChange: (period: TeamUsagePeriod) => void;
  onFiltersChange: (filters: TeamUsageFilters) => void;
  onReset: () => void;
}

/**
 * AC 3: filter by agent (multi-select), action type (multi-select), date
 * range (period presets), and framework (multi-select). Every toggle is
 * a real, individually keyboard-focusable, labeled checkbox (technical_details
 * AC: "keyboard navigable") rather than a native `<select multiple>` —
 * a multi-select `<select>` is notoriously hard to operate without a
 * mouse (ctrl/cmd-click to add to a selection is not discoverable via
 * keyboard alone), so this codebase's own established pattern of plain
 * accessible HTML (see HealthFilterBar) is extended here with checkbox
 * groups instead of introducing a new multi-select widget from scratch.
 */
export function UsageFilterPanel({ agents, actionTypes, period, filters, onPeriodChange, onFiltersChange, onReset }: UsageFilterPanelProps) {
  const hasActiveFilters = Boolean(filters.agentIds?.length || filters.actionTypes?.length || filters.frameworks?.length);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <div role="group" aria-label="Date range" className="border-border inline-flex rounded-md border">
          {TEAM_USAGE_PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={period === p}
              onClick={() => onPeriodChange(p)}
              className={cn("px-3 py-1.5 text-sm first:rounded-l-md last:rounded-r-md", period === p ? "bg-primary text-primary-foreground" : "hover:bg-muted")}
            >
              {PERIOD_LABEL[p]}
            </button>
          ))}
        </div>

        {hasActiveFilters && (
          <button type="button" className="text-primary text-sm underline" onClick={onReset}>
            Reset filters
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-6">
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium">Framework</legend>
          {TEAM_USAGE_FRAMEWORKS.map((framework) => (
            <label key={framework} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={filters.frameworks?.includes(framework) ?? false}
                onChange={() => onFiltersChange({ ...filters, frameworks: toggle(filters.frameworks, framework) })}
              />
              {FRAMEWORK_LABEL[framework]}
            </label>
          ))}
        </fieldset>

        {actionTypes.length > 0 && (
          <fieldset className="flex flex-col gap-1">
            <legend className="text-sm font-medium">Action type</legend>
            {actionTypes.map((actionType) => (
              <label key={actionType} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={filters.actionTypes?.includes(actionType) ?? false}
                  onChange={() => onFiltersChange({ ...filters, actionTypes: toggle(filters.actionTypes, actionType) })}
                />
                {actionType}
              </label>
            ))}
          </fieldset>
        )}

        {agents.length > 0 && (
          <fieldset className="flex max-h-40 flex-col gap-1 overflow-y-auto">
            <legend className="text-sm font-medium">Agent</legend>
            {agents.map((agent) => (
              <label key={agent.agentId} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={filters.agentIds?.includes(agent.agentId) ?? false}
                  onChange={() => onFiltersChange({ ...filters, agentIds: toggle(filters.agentIds, agent.agentId) })}
                />
                {agent.agentName}
              </label>
            ))}
          </fieldset>
        )}
      </div>
    </div>
  );
}
