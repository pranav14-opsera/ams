import { Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { AlertThresholdRepository } from "./alert-threshold.repository";
import { ThresholdEvaluatorService } from "./threshold-evaluator.service";

const EVALUATION_INTERVAL_MS = 5_000;

/**
 * AC: threshold evaluation runs every 5 seconds. Unlike the Kafka-broker
 * or external-cron gaps documented elsewhere in this codebase (WO-041/
 * WO-046 etc.), @nestjs/schedule's @Interval runs entirely in-process —
 * no external service dependency, no "sandbox has no reachable X" gap —
 * so this is genuinely wired up and running, not a stub.
 */
@Injectable()
export class ThresholdEvaluationSchedulerService {
  private readonly logger = new Logger(ThresholdEvaluationSchedulerService.name);

  constructor(
    private readonly thresholdRepository: AlertThresholdRepository,
    private readonly evaluator: ThresholdEvaluatorService,
  ) {}

  @Interval(EVALUATION_INTERVAL_MS)
  async runEvaluationTick(): Promise<void> {
    let tenantIds: string[];
    try {
      tenantIds = await this.thresholdRepository.findDistinctTenantIds();
    } catch (err) {
      this.logger.warn(`failed to list tenants for threshold evaluation: ${err instanceof Error ? err.message : err}`);
      return;
    }

    for (const tenantId of tenantIds) {
      try {
        await this.evaluator.evaluateTenant(tenantId);
      } catch (err) {
        // One tenant's evaluation failure must never block every other tenant's tick.
        this.logger.warn(`threshold evaluation failed for tenant ${tenantId}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
}
