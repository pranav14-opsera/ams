import { Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { QualityScoreRepository } from "../quality-score/quality-score.repository";
import { DriftDetectionService } from "./drift-detection.service";

const TICK_INTERVAL_MS = 60 * 60 * 1000; // AC: "hourly"

/** AC: hourly, only for agents with an established quality-score baseline. */
@Injectable()
export class DriftDetectionSchedulerService {
  private readonly logger = new Logger(DriftDetectionSchedulerService.name);

  constructor(
    private readonly qualityScoreRepository: QualityScoreRepository,
    private readonly driftDetectionService: DriftDetectionService,
  ) {}

  @Interval(TICK_INTERVAL_MS)
  async runTick(now: Date = new Date()): Promise<void> {
    let tenantIds: string[];
    try {
      tenantIds = await this.qualityScoreRepository.findDistinctTenantIdsWithEstablishedBaselines();
    } catch (err) {
      this.logger.warn(`failed to list tenants for drift detection: ${err instanceof Error ? err.message : err}`);
      return;
    }

    for (const tenantId of tenantIds) {
      let agentIds: string[];
      try {
        agentIds = await this.qualityScoreRepository.findAgentIdsWithEstablishedBaselines(undefined, tenantId);
      } catch (err) {
        this.logger.warn(`failed to list baselined agents for tenant ${tenantId}: ${err instanceof Error ? err.message : err}`);
        continue;
      }

      for (const agentId of agentIds) {
        try {
          await this.driftDetectionService.evaluateAgent(undefined, tenantId, agentId, now);
        } catch (err) {
          this.logger.warn(`drift evaluation failed for agent ${agentId} (tenant ${tenantId}): ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  }
}
