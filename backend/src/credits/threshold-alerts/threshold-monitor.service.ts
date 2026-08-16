import { Injectable, Logger } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { CreditBudgetService } from "../budget/credit-budget.service";
import { CreditThresholdAlertDeliveryService } from "./credit-threshold-alert-delivery.service";
import { CreditThresholdAlertRepository } from "./credit-threshold-alert.repository";
import { CREDIT_ALERT_THRESHOLD_LEVELS, type CreditAlert, type CreditAlertPayload, type CreditAlertThresholdLevel } from "./credit-threshold-alert.types";

const RECOMMENDED_ACTIONS: Record<CreditAlertThresholdLevel, string> = {
  90: "Immediate action required: request additional budget or restrict further usage to avoid exhausting this team's allocation before the period ends.",
  75: "Review current usage trends; consider requesting additional budget if this pace of consumption continues.",
};

/**
 * AC: evaluates consumption after each reconciliation batch (event-driven
 * — see CreditReconciliationService's own optional-DI call site — not a
 * polling loop), generating at most one alert per (team, threshold,
 * period). Each threshold level's own dedup row is independent, so a
 * team crossing both 75% and 90% in the SAME batch genuinely gets TWO
 * separate alerts, exactly as the AC describes them ("a separate alert
 * is generated" for 90%, distinct from the 75% one).
 */
@Injectable()
export class ThresholdMonitorService {
  private readonly logger = new Logger(ThresholdMonitorService.name);

  constructor(
    private readonly budgetService: CreditBudgetService,
    private readonly alertRepository: CreditThresholdAlertRepository,
    private readonly deliveryService: CreditThresholdAlertDeliveryService,
  ) {}

  async evaluateThresholds(client: Pool | PoolClient | undefined, tenantId: string, teamIds: string[], month: number, year: number): Promise<CreditAlert[]> {
    const generated: CreditAlert[] = [];

    for (const teamId of teamIds) {
      try {
        const alertsForTeam = await this.evaluateTeam(client, tenantId, teamId, month, year);
        generated.push(...alertsForTeam);
      } catch (err) {
        this.logger.warn(`threshold evaluation failed for team ${teamId} (tenant ${tenantId}): ${err instanceof Error ? err.message : err}`);
      }
    }

    return generated;
  }

  private async evaluateTeam(client: Pool | PoolClient | undefined, tenantId: string, teamId: string, month: number, year: number): Promise<CreditAlert[]> {
    let summary;
    try {
      summary = await this.budgetService.getTeamBudget(client, tenantId, teamId, month, year);
    } catch {
      return []; // no budget configured for this team/period at all — nothing to evaluate
    }

    // AC: zero-allocation guard — consumptionPercentage is null (not a fabricated 0 or Infinity) when allocatedCredits is 0, per CreditBudgetService's own convention.
    if (summary.consumptionPercentage === null) return [];

    const generated: CreditAlert[] = [];
    for (const level of CREDIT_ALERT_THRESHOLD_LEVELS) {
      if (summary.consumptionPercentage < level) continue;

      const alert = await this.alertRepository.tryCreateAlert(client, tenantId, teamId, level, summary.consumptionPercentage, month, year);
      if (!alert) continue; // duplicate — already alerted this team/threshold/period

      const teamName = (await this.alertRepository.getTeamName(client, tenantId, teamId)) ?? teamId;
      const [teamLeadEmails, financeManagerEmails] = await Promise.all([this.alertRepository.findTeamLeadEmails(client, tenantId, teamId), this.alertRepository.findFinanceManagerEmails(client, tenantId)]);

      const payload: CreditAlertPayload = {
        teamId,
        teamName,
        thresholdLevel: level,
        allocatedCredits: summary.allocatedCredits,
        consumedCredits: summary.consumedCredits,
        remainingCredits: summary.remainingCredits,
        consumptionPercentage: summary.consumptionPercentage,
        projectedExhaustionDate: summary.projectedExhaustionDate,
        recommendedAction: RECOMMENDED_ACTIONS[level],
      };

      await this.deliveryService.deliver(tenantId, payload, [...new Set([...teamLeadEmails, ...financeManagerEmails])]);
      generated.push(alert);
    }

    return generated;
  }
}
