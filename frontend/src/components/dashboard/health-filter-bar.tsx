"use client";

import { AGENT_FRAMEWORKS, AGENT_HEALTH_STATUSES, type AgentHealthFilters } from "@/types/dashboard";

export interface HealthFilterBarProps {
  filters: AgentHealthFilters;
  onChange: (filters: AgentHealthFilters) => void;
}

/** AC: filtering by team, framework, agent status, and health severity. Team filtering is a free-text UUID field for now — no team-picker component exists yet in this codebase (out of this WO's scope to build one). */
export function HealthFilterBar({ filters, onChange }: HealthFilterBarProps) {
  return (
    <div className="flex flex-wrap items-end gap-4">
      <label className="flex flex-col gap-1 text-sm">
        <span>Framework</span>
        <select
          className="border-border rounded-md border bg-transparent px-2 py-1.5 text-sm"
          value={filters.framework ?? ""}
          onChange={(e) => onChange({ ...filters, framework: (e.target.value || undefined) as AgentHealthFilters["framework"] })}
        >
          <option value="">All frameworks</option>
          {AGENT_FRAMEWORKS.map((framework) => (
            <option key={framework} value={framework}>
              {framework}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span>Health status</span>
        <select
          className="border-border rounded-md border bg-transparent px-2 py-1.5 text-sm"
          value={filters.status ?? ""}
          onChange={(e) => onChange({ ...filters, status: (e.target.value || undefined) as AgentHealthFilters["status"] })}
        >
          <option value="">All statuses</option>
          {AGENT_HEALTH_STATUSES.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span>Team ID</span>
        <input
          className="border-border rounded-md border bg-transparent px-2 py-1.5 text-sm"
          value={filters.teamId ?? ""}
          onChange={(e) => onChange({ ...filters, teamId: e.target.value || undefined })}
          placeholder="Filter by team UUID"
        />
      </label>
    </div>
  );
}
