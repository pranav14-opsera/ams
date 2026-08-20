"use client";

import { AGENT_FRAMEWORKS, AGENT_LIFECYCLE_STATUSES, type AgentLifecycleStatus, type AgentFramework, type AgentRegistryFilters } from "@/types/dashboard";

const FRAMEWORK_LABEL: Record<AgentFramework, string> = {
  langchain: "LangChain",
  crewai: "CrewAI",
  autogen: "AutoGen",
  generic_rest: "REST",
};

const STATUS_LABEL: Record<AgentLifecycleStatus, string> = {
  connecting: "Connecting",
  active: "Active",
  paused: "Paused",
  retired: "Retired",
  decommissioned: "Decommissioned",
};

function toggle<T>(list: T[] | undefined, value: T): T[] | undefined {
  const current = list ?? [];
  const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
  return next.length > 0 ? next : undefined;
}

export interface AgentRegistryFilterBarProps {
  filters: AgentRegistryFilters;
  onChange: (filters: AgentRegistryFilters) => void;
}

/**
 * AC: "filtering by framework type (multi-select...), lifecycle status
 * (multi-select...), and team assignment." Real, individually
 * keyboard-focusable checkboxes for the two multi-selects (this
 * codebase's own established pattern — see UsageFilterPanel's own
 * comment on why a native multi-select `<select>` isn't used) plus a
 * free-text team-UUID field, matching HealthFilterBar's own "no
 * team-picker component exists yet" convention.
 */
export function AgentRegistryFilterBar({ filters, onChange }: AgentRegistryFilterBarProps) {
  const hasActiveFilters = Boolean(filters.framework?.length || filters.status?.length || filters.teamId);

  return (
    <div className="flex flex-wrap items-start gap-6">
      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-medium">Framework</legend>
        {AGENT_FRAMEWORKS.map((framework) => (
          <label key={framework} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={filters.framework?.includes(framework) ?? false}
              onChange={() => onChange({ ...filters, framework: toggle(filters.framework, framework) })}
            />
            {FRAMEWORK_LABEL[framework]}
          </label>
        ))}
      </fieldset>

      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm font-medium">Lifecycle status</legend>
        {AGENT_LIFECYCLE_STATUSES.map((status) => (
          <label key={status} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={filters.status?.includes(status) ?? false}
              onChange={() => onChange({ ...filters, status: toggle(filters.status, status) })}
            />
            {STATUS_LABEL[status]}
          </label>
        ))}
      </fieldset>

      <label className="flex flex-col gap-1 text-sm">
        <span>Team</span>
        <input
          className="border-border rounded-md border bg-transparent px-2 py-1.5 text-sm"
          value={filters.teamId ?? ""}
          onChange={(e) => onChange({ ...filters, teamId: e.target.value || undefined })}
          placeholder="Filter by team UUID"
        />
      </label>

      {hasActiveFilters && (
        <button type="button" className="text-primary self-end text-sm underline" onClick={() => onChange({})}>
          Reset filters
        </button>
      )}
    </div>
  );
}
