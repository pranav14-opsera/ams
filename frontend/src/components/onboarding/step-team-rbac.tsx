"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useCreateTeamMutation, useTeamsQuery } from "@/hooks/useTeamsQuery";
import { useAllocateBudgetMutation, useUpsertCreditPoolMutation } from "@/hooks/useCreditPool";

export interface StepTeamRbacProps {
  agentId: string | null;
  onComplete: (teamId: string) => void;
}

/**
 * AC 7: create initial team(s), assign the first agent (if registered)
 * to a team, and configure the initial credit budget allocation from the
 * organization's pool.
 *
 * The first agent — if one was registered in Step 4 — was already
 * assigned to a team there (WO-080's own Step 3, Assign Team, is a
 * required part of agent registration; an agent cannot be created
 * without a team). This step's own "assign the first agent to a team"
 * is therefore satisfied by that earlier assignment, not re-implemented
 * here as a second, separate reassignment call — this step focuses on
 * what Step 4 does NOT cover: creating the team itself (if the customer
 * skipped Step 4, or wants an additional team) and the credit budget.
 */
export function StepTeamRbac({ agentId, onComplete }: StepTeamRbacProps) {
  const [teamName, setTeamName] = useState("");
  const [teamDescription, setTeamDescription] = useState("");
  const [poolTotal, setPoolTotal] = useState(10000);
  const [allocatedCredits, setAllocatedCredits] = useState(5000);

  const teamsQuery = useTeamsQuery();
  const createTeam = useCreateTeamMutation();
  const upsertPool = useUpsertCreditPoolMutation();
  const allocateBudget = useAllocateBudgetMutation();

  const now = new Date();
  const [createdTeamId, setCreatedTeamId] = useState<string | null>(null);
  const budgetAllocated = allocateBudget.isSuccess;

  function handleCreateTeam() {
    if (!teamName.trim()) return;
    createTeam.mutate(teamName.trim(), { onSuccess: (team) => setCreatedTeamId(team.id) });
  }

  function handleAllocateBudget() {
    const teamId = createdTeamId ?? teamsQuery.data?.[0]?.id;
    if (!teamId) return;
    upsertPool.mutate(
      { totalCredits: poolTotal, effectiveMonth: now.getUTCMonth() + 1, effectiveYear: now.getUTCFullYear() },
      {
        onSuccess: () =>
          allocateBudget.mutate(
            { teamId, allocatedCredits, alertThreshold75: true, alertThreshold90: true, effectiveMonth: now.getUTCMonth() + 1, effectiveYear: now.getUTCFullYear() },
            { onSuccess: () => onComplete(teamId) },
          ),
      },
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-semibold">Team &amp; RBAC Setup</h2>
        <p className="text-muted-foreground text-sm">Create your first team and allocate its initial credit budget.</p>
      </div>

      {agentId && (
        <p role="status" className="rounded-md border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-900">
          Your first agent is already assigned to a team from Step 4.
        </p>
      )}

      {!createdTeamId && (
        <div className="flex max-w-md flex-col gap-2">
          <div className="flex flex-col gap-1">
            <label htmlFor="team-name" className="text-sm font-medium">
              Team name <span aria-hidden="true">*</span>
            </label>
            <input
              id="team-name"
              type="text"
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
              className="border-border h-9 rounded-md border bg-transparent px-2 text-sm"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="team-description" className="text-sm font-medium">
              Description
            </label>
            <textarea
              id="team-description"
              value={teamDescription}
              onChange={(e) => setTeamDescription(e.target.value)}
              rows={2}
              className="border-border rounded-md border bg-transparent px-2 py-1 text-sm"
            />
          </div>
          <Button type="button" onClick={handleCreateTeam} disabled={!teamName.trim() || createTeam.isPending}>
            {createTeam.isPending ? "Creating…" : "Create Team"}
          </Button>
          {createTeam.isError && (
            <p role="alert" className="text-sm text-red-700">
              {createTeam.error instanceof Error ? createTeam.error.message : "Failed to create team."}
            </p>
          )}
        </div>
      )}

      {createdTeamId && (
        <div className="flex max-w-md flex-col gap-4 border-t pt-4">
          <h3 className="text-sm font-semibold">Initial credit budget</h3>
          <div className="flex flex-col gap-1">
            <label htmlFor="pool-total" className="text-sm font-medium">
              Organization credit pool (total)
            </label>
            <input
              id="pool-total"
              type="number"
              min={0}
              value={poolTotal}
              onChange={(e) => setPoolTotal(Number(e.target.value))}
              className="border-border h-9 rounded-md border bg-transparent px-2 text-sm"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="allocated-credits" className="text-sm font-medium">
              Allocate to this team
            </label>
            <input
              id="allocated-credits"
              type="number"
              min={0}
              max={poolTotal}
              value={allocatedCredits}
              onChange={(e) => setAllocatedCredits(Number(e.target.value))}
              className="border-border h-9 rounded-md border bg-transparent px-2 text-sm"
            />
          </div>
          <Button type="button" onClick={handleAllocateBudget} disabled={budgetAllocated || upsertPool.isPending || allocateBudget.isPending}>
            {budgetAllocated ? "Budget allocated" : upsertPool.isPending || allocateBudget.isPending ? "Allocating…" : "Allocate Credit Budget"}
          </Button>
          {(upsertPool.isError || allocateBudget.isError) && (
            <p role="alert" className="text-sm text-red-700">
              {(upsertPool.error instanceof Error && upsertPool.error.message) || (allocateBudget.error instanceof Error && allocateBudget.error.message) || "Failed to allocate credit budget."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
