import { Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { HardCapEnforcementService } from "./hard-cap-enforcement.service";
import { HardCapPauseStateRepository } from "./hard-cap-pause-state.repository";

// AC: "auto-resumes within 60 seconds" — a 15s tick keeps every currently
// auto-paused team's resume check comfortably inside that bound.
const TICK_INTERVAL_MS = 15_000;

@Injectable()
export class HardCapResumeSchedulerService {
  private readonly logger = new Logger(HardCapResumeSchedulerService.name);

  constructor(
    private readonly pauseStateRepository: HardCapPauseStateRepository,
    private readonly enforcementService: HardCapEnforcementService,
  ) {}

  @Interval(TICK_INTERVAL_MS)
  async runTick(): Promise<void> {
    await this.runTickUnlocked();
  }

  async runTickUnlocked(now: Date = new Date()): Promise<void> {
    let teams: Array<{ tenantId: string; teamId: string }>;
    try {
      teams = await this.pauseStateRepository.findDistinctPausedTeams();
    } catch (err) {
      this.logger.warn(`failed to list auto-paused teams for hard-cap resume check: ${err instanceof Error ? err.message : err}`);
      return;
    }

    for (const { tenantId, teamId } of teams) {
      try {
        await this.enforcementService.resumeIfBelowCap(tenantId, teamId, now.getUTCMonth() + 1, now.getUTCFullYear());
      } catch (err) {
        this.logger.warn(`hard-cap resume check failed for tenant ${tenantId} team ${teamId}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
}
