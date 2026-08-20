import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { AlertDeliveryService } from "../../alerts/alert-delivery.service";
import { AlertEventRepository } from "../../alerts/alert-event.repository";
import { AgentsRepository } from "../../agents/agents.repository";
import { LifecycleService } from "../../agents/lifecycle.service";
import { CreditBudgetService } from "../budget/credit-budget.service";
import { HardCapPauseStateRepository } from "./hard-cap-pause-state.repository";

const HARD_CAP_METRIC_NAME = "credit_hard_cap_reached";

export interface HardCapEnforcementOutcome {
  pausedAgentIds: string[];
  resumedAgentIds: string[];
}

/**
 * AC: when a team's consumed credits reach or exceed its `hard_cap`
 * (WO-068's `credit_budgets.hard_cap` — the single canonical hard-cap
 * value; see CreditBudgetService.allocate, which keeps WO-066's
 * `team_credit_limits.hard_cap` — the metering engine's own real-time
 * near-cap buffer — in sync with it), every active agent on that team
 * is paused via WO-032's own LifecycleService, with a critical alert and
 * a full audit trail. Once consumption drops back below the cap (a
 * Finance Manager raising the budget), every agent THIS mechanism
 * itself paused is auto-resumed — never an agent an operator paused
 * manually for an unrelated reason, which is why `hard_cap_pause_state`
 * exists as its own tracking table rather than inferring "was auto-
 * paused" from lifecycle_status alone.
 */
@Injectable()
export class HardCapEnforcementService {
  private readonly logger = new Logger(HardCapEnforcementService.name);

  constructor(
    private readonly pauseStateRepository: HardCapPauseStateRepository,
    private readonly budgetService: CreditBudgetService,
    private readonly agentsRepository: AgentsRepository,
    private readonly lifecycleService: LifecycleService,
    private readonly alertEventRepository?: AlertEventRepository,
    private readonly alertDeliveryService?: AlertDeliveryService,
  ) {}

  /** Called after real consumption changes (reconciliation batch / synchronous ledger fallthrough). Pauses the team's agents if the cap has just been reached; otherwise a no-op (resuming happens on its own schedule — see HardCapResumeSchedulerService — since a consumption EVENT never by itself indicates the budget was just raised). */
  async enforceIfBreached(client: Pool | PoolClient | undefined, tenantId: string, teamId: string, month: number, year: number): Promise<HardCapEnforcementOutcome> {
    const summary = await this.safeGetTeamBudget(client, tenantId, teamId, month, year);
    if (!summary || summary.hardCap === null) {
      return { pausedAgentIds: [], resumedAgentIds: [] };
    }

    if (summary.consumedCredits < summary.hardCap) {
      return { pausedAgentIds: [], resumedAgentIds: [] };
    }

    const { rows: agents } = await this.agentsRepository.findAll(client, tenantId, { teamId, lifecycleStatus: "active", limit: 1000, offset: 0 });
    const pausedAgentIds: string[] = [];

    for (const agent of agents) {
      try {
        await this.lifecycleService.transition(
          client,
          tenantId,
          null,
          agent.id,
          "paused",
          `Automatically paused: team consumed ${summary.consumedCredits} credits, reaching or exceeding its hard cap of ${summary.hardCap}.`,
        );
        await this.pauseStateRepository.recordPause(client, tenantId, teamId, agent.id);
        pausedAgentIds.push(agent.id);
        await this.raiseHardCapAlert(tenantId, agent.id, summary.consumedCredits, summary.hardCap);
      } catch (err) {
        this.logger.warn(`hard-cap pause failed for agent ${agent.id} (tenant ${tenantId}, team ${teamId}): ${err instanceof Error ? err.message : err}`);
      }
    }

    return { pausedAgentIds, resumedAgentIds: [] };
  }

  /** AC: "auto-resumes within 60 seconds when a Finance Manager increases the budget above current consumption" — only ever touches agents THIS mechanism paused (tracked in hard_cap_pause_state), and only those still actually in the `paused` lifecycle state (an agent an operator separately retired/decommissioned in the meantime is left alone). */
  async resumeIfBelowCap(tenantId: string, teamId: string, month: number, year: number): Promise<HardCapEnforcementOutcome> {
    const pausedRows = await this.pauseStateRepository.findPausedForTeam(undefined, tenantId, teamId);
    if (pausedRows.length === 0) {
      return { pausedAgentIds: [], resumedAgentIds: [] };
    }

    const summary = await this.safeGetTeamBudget(undefined, tenantId, teamId, month, year);
    if (summary && summary.hardCap !== null && summary.consumedCredits >= summary.hardCap) {
      return { pausedAgentIds: [], resumedAgentIds: [] };
    }

    const resumedAgentIds: string[] = [];
    for (const row of pausedRows) {
      try {
        const agent = await this.agentsRepository.findOne(undefined, tenantId, row.agentId);
        if (!agent || agent.lifecycle_status !== "paused") {
          // Manually retired/decommissioned (or already resumed some other way) in the meantime — leave it alone, just stop tracking it.
          await this.pauseStateRepository.clearPause(undefined, tenantId, row.agentId);
          continue;
        }
        await this.lifecycleService.transition(undefined, tenantId, null, row.agentId, "active", "Automatically resumed: team consumption is back below its hard cap.");
        await this.pauseStateRepository.clearPause(undefined, tenantId, row.agentId);
        resumedAgentIds.push(row.agentId);
      } catch (err) {
        this.logger.warn(`hard-cap resume failed for agent ${row.agentId} (tenant ${tenantId}, team ${teamId}): ${err instanceof Error ? err.message : err}`);
      }
    }

    return { pausedAgentIds: [], resumedAgentIds };
  }

  private async safeGetTeamBudget(client: Pool | PoolClient | undefined, tenantId: string, teamId: string, month: number, year: number) {
    try {
      return await this.budgetService.getTeamBudget(client, tenantId, teamId, month, year);
    } catch (err) {
      if (err instanceof NotFoundException) return null; // no budget configured for this period — nothing to enforce against.
      throw err;
    }
  }

  private async raiseHardCapAlert(tenantId: string, agentId: string, consumedCredits: number, hardCap: number): Promise<void> {
    if (!this.alertEventRepository || !this.alertDeliveryService) return;
    try {
      const alertEvent = await this.alertEventRepository.create(undefined, tenantId, agentId, {
        metricName: HARD_CAP_METRIC_NAME,
        thresholdValue: hardCap,
        actualValue: consumedCredits,
        severity: "critical",
        breachTimestamp: new Date(),
        detectionMethod: "threshold",
      });
      await this.alertDeliveryService.deliver(alertEvent);
    } catch (err) {
      this.logger.warn(`failed to raise hard-cap alert for agent ${agentId} (tenant ${tenantId}) — the pause itself already succeeded: ${err instanceof Error ? err.message : err}`);
    }
  }
}
