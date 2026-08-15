import { Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { QualityScoreLockService } from "./quality-score-lock.service";
import { QualityScoreRepository } from "./quality-score.repository";
import { QualityScoreService } from "./quality-score.service";

const TICK_INTERVAL_MS = 5 * 60 * 1000; // AC: "every 5 minutes"

/** AC: computes scores every 5 minutes for every active agent, gated behind a distributed lock so multiple running instances never double-compute/double-write the same tick. */
@Injectable()
export class QualityScoreSchedulerService {
  private readonly logger = new Logger(QualityScoreSchedulerService.name);

  constructor(
    private readonly repository: QualityScoreRepository,
    private readonly service: QualityScoreService,
    private readonly lock: QualityScoreLockService,
  ) {}

  @Interval(TICK_INTERVAL_MS)
  async runTick(): Promise<void> {
    const release = await this.lock.acquire();
    if (!release) {
      this.logger.debug("another instance already holds the quality-score scheduler lock this tick — skipping");
      return;
    }

    try {
      await this.runTickUnlocked();
    } finally {
      await release();
    }
  }

  async runTickUnlocked(now: Date = new Date()): Promise<void> {
    let tenantIds: string[];
    try {
      tenantIds = await this.repository.findDistinctTenantIdsWithActiveAgents();
    } catch (err) {
      this.logger.warn(`failed to list tenants for quality-score computation: ${err instanceof Error ? err.message : err}`);
      return;
    }

    for (const tenantId of tenantIds) {
      let agentIds: string[];
      try {
        agentIds = await this.repository.findActiveAgentIds(undefined, tenantId);
      } catch (err) {
        this.logger.warn(`failed to list agents for tenant ${tenantId}: ${err instanceof Error ? err.message : err}`);
        continue;
      }

      for (const agentId of agentIds) {
        try {
          await this.service.computeAndStoreScoreForAgent(undefined, tenantId, agentId, now);
          await this.service.checkAndEstablishBaseline(undefined, tenantId, agentId, now);
        } catch (err) {
          this.logger.warn(`quality-score computation failed for agent ${agentId} (tenant ${tenantId}): ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  }
}
