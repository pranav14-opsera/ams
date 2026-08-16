import { Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { CreditProcessedEventRepository } from "./credit-processed-event.repository";

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily is plenty for a 7-day-TTL table — no AC-specified cadence beyond the retention window itself
const RETENTION_DAYS = 7; // AC: "7-day TTL"

/** AC: "a scheduled cleanup job that purges credit_processed_events older than 7 days to prevent table bloat." */
@Injectable()
export class CreditProcessedEventsCleanupSchedulerService {
  private readonly logger = new Logger(CreditProcessedEventsCleanupSchedulerService.name);

  constructor(private readonly repository: CreditProcessedEventRepository) {}

  @Interval(CLEANUP_INTERVAL_MS)
  async runCleanup(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    try {
      const purged = await this.repository.purgeOlderThan(undefined, cutoff);
      if (purged > 0) this.logger.log(`purged ${purged} credit_processed_events row(s) older than ${RETENTION_DAYS} days`);
      return purged;
    } catch (err) {
      this.logger.warn(`credit_processed_events cleanup failed: ${err instanceof Error ? err.message : err}`);
      return 0;
    }
  }
}
