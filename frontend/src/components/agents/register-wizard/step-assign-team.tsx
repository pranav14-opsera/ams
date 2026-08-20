"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/stores/app-store";
import { useCreateTeamMutation, useTeamsQuery } from "@/hooks/useTeamsQuery";

export interface StepAssignTeamProps {
  teamId: string | null;
  onSelectTeam: (teamId: string) => void;
}

/** AC 6: team-assignment dropdown from the user's accessible teams (name + member count), with inline "Create Team" for Admin users. edge_case: "Empty team list" prompts inline creation (Admin) or a link to team management. */
export function StepAssignTeam({ teamId, onSelectTeam }: StepAssignTeamProps) {
  const isAdmin = useAppStore((s) => s.auth.roles.includes("platform_admin"));
  const teamsQuery = useTeamsQuery();
  const createTeam = useCreateTeamMutation();
  const [newTeamName, setNewTeamName] = useState("");
  const [showCreateForm, setShowCreateForm] = useState(false);

  async function handleCreateTeam() {
    if (!newTeamName.trim()) return;
    const team = await createTeam.mutateAsync(newTeamName.trim());
    onSelectTeam(team.id);
    setNewTeamName("");
    setShowCreateForm(false);
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">Assign team</h2>
        <p className="text-muted-foreground text-sm">Choose which team this agent belongs to.</p>
      </div>

      {teamsQuery.isLoading && <p role="status">Loading teams…</p>}

      {teamsQuery.isError && (
        <p role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          Could not load teams. Please try again.
        </p>
      )}

      {teamsQuery.isSuccess && teamsQuery.data.length === 0 && !isAdmin && (
        <p className="text-muted-foreground text-sm">
          No teams exist yet. Ask a Platform Administrator to create one before registering an agent.
        </p>
      )}

      {teamsQuery.isSuccess && teamsQuery.data.length > 0 && (
        <div className="flex flex-col gap-1">
          <label htmlFor="team-select" className="text-sm font-medium">
            Team <span aria-hidden="true">*</span>
          </label>
          <select
            id="team-select"
            value={teamId ?? ""}
            onChange={(e) => onSelectTeam(e.target.value)}
            className="border-border h-9 max-w-md rounded-md border bg-transparent px-2 text-sm"
          >
            <option value="" disabled>
              Select a team…
            </option>
            {teamsQuery.data.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name} ({team.memberCount ?? 0} member{team.memberCount === 1 ? "" : "s"})
              </option>
            ))}
          </select>
        </div>
      )}

      {isAdmin && (
        <div className="max-w-md">
          {!showCreateForm ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setShowCreateForm(true)}>
              Create new team
            </Button>
          ) : (
            <div className="flex flex-col gap-2">
              <label htmlFor="new-team-name" className="text-sm font-medium">
                New team name
              </label>
              <div className="flex gap-2">
                <input
                  id="new-team-name"
                  type="text"
                  value={newTeamName}
                  onChange={(e) => setNewTeamName(e.target.value)}
                  className="border-border h-9 flex-1 rounded-md border bg-transparent px-2 text-sm"
                />
                <Button type="button" size="sm" onClick={handleCreateTeam} disabled={!newTeamName.trim() || createTeam.isPending}>
                  {createTeam.isPending ? "Creating…" : "Create"}
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setShowCreateForm(false)}>
                  Cancel
                </Button>
              </div>
              {createTeam.isError && (
                <p role="alert" className="text-sm text-red-700">
                  {createTeam.error instanceof Error ? createTeam.error.message : "Failed to create team."}
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
