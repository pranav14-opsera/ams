"use client";

import { useAppStore } from "@/stores/app-store";
import type { TeamRef } from "@/types/dashboard";

// Mirrors RbacGuard's own team-scoped role list (backend/src/rbac/rbac.guard.ts TEAM_SCOPED_ROLES) — a Team Lead/Agent Operator has no selector at all (their team is fixed, resolved server-side), only an org-scoped role gets to switch teams.
const TEAM_SCOPED_ROLES = ["team_lead", "agent_operator"];

export interface TeamSelectorProps {
  teams: TeamRef[];
  selectedTeamId: string | undefined;
  onChange: (teamId: string) => void;
}

/** AC 6: "Platform Administrator sees a team selector dropdown that switches the dashboard context between teams without page reload." Renders only for an org-scoped caller — a Team Lead/Agent Operator has exactly one (or a fixed few) team(s) and no reason to see a switcher for teams they can't access anyway. */
export function TeamSelector({ teams, selectedTeamId, onChange }: TeamSelectorProps) {
  const roles = useAppStore((s) => s.auth.roles);
  const isTeamScoped = roles.some((role) => TEAM_SCOPED_ROLES.includes(role));

  if (isTeamScoped || teams.length <= 1) return null;

  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="font-medium">Team</span>
      <select
        className="border-border rounded-md border bg-transparent px-2 py-1.5 text-sm"
        value={selectedTeamId ?? ""}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Select team"
      >
        {teams.map((team) => (
          <option key={team.id} value={team.id}>
            {team.name}
          </option>
        ))}
      </select>
    </label>
  );
}
