import { Inject, Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { DataClassification } from "../../classification/data-classification.enum";
import { AUDIT_SERVICE, type AuditServicePort } from "../../tenants/ports/audit-service.port";
import { AlertAutoTuneStateRepository } from "./alert-auto-tune-state.repository";
import { FalsePositiveFeedbackRepository } from "./false-positive-feedback.repository";
import { AUTO_TUNE_MAX_MULTIPLIER, AUTO_TUNE_MIN_FALSE_POSITIVES, AUTO_TUNE_STEP_MULTIPLIER, AUTO_TUNE_WINDOW_DAYS } from "./alert-suppression.types";

const TUNE_INTERVAL_MS = 60 * 60 * 1000; // AC: "hourly"

/**
 * AC: a pattern (agent+metric) with 3+ false-positive feedbacks and ZERO
 * confirmed feedbacks within a trailing 7-day window gets its warning
 * threshold widened by one tuning step (capped at 2x original).
 *
 * Re-tuning safety: only feedback newer than the pattern's own
 * feedback_cursor (the timestamp of its last tuning pass, or -infinity if
 * never tuned) counts toward the 3+ threshold. Without this, a pattern
 * that accumulated 3 false positives once would re-trigger every single
 * hourly run forever (the 7-day window would keep re-including the same
 * old feedback), causing runaway multiplier growth up to the 2x cap
 * within a few hours instead of requiring genuinely NEW evidence each
 * time.
 */
@Injectable()
export class AutoTuneSchedulerService {
  private readonly logger = new Logger(AutoTuneSchedulerService.name);

  constructor(
    private readonly feedbackRepository: FalsePositiveFeedbackRepository,
    private readonly autoTuneStateRepository: AlertAutoTuneStateRepository,
    @Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort,
  ) {}

  @Interval(TUNE_INTERVAL_MS)
  async runTuningTick(): Promise<void> {
    let tenantIds: string[];
    try {
      tenantIds = await this.feedbackRepository.findDistinctTenantIds();
    } catch (err) {
      this.logger.warn(`failed to list tenants for auto-tuning: ${err instanceof Error ? err.message : err}`);
      return;
    }

    for (const tenantId of tenantIds) {
      try {
        await this.tuneTenant(tenantId);
      } catch (err) {
        this.logger.warn(`auto-tune failed for tenant ${tenantId}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  async tuneTenant(tenantId: string, now: Date = new Date()): Promise<void> {
    const windowStart = new Date(now.getTime() - AUTO_TUNE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const patterns = await this.feedbackRepository.findDistinctPatternsWithFeedback(undefined, tenantId, windowStart);

    for (const pattern of patterns) {
      const existingState = await this.autoTuneStateRepository.findByPattern(undefined, tenantId, pattern.agentId, pattern.metricName);
      if (existingState && existingState.warningMultiplier >= AUTO_TUNE_MAX_MULTIPLIER) continue; // already at the cap — nothing more to do

      // Only feedback newer than the pattern's own cursor (last tuning, or -infinity) counts — see class doc.
      const since = existingState?.feedbackCursor && existingState.feedbackCursor > windowStart ? existingState.feedbackCursor : windowStart;
      const counts = await this.feedbackRepository.getPatternFeedback(undefined, tenantId, pattern.agentId, pattern.metricName, AUTO_TUNE_WINDOW_DAYS, since);

      if (counts.falsePositiveCount < AUTO_TUNE_MIN_FALSE_POSITIVES || counts.confirmedCount > 0) continue;

      const updated = await this.autoTuneStateRepository.applyTuningStep(undefined, tenantId, pattern.agentId, pattern.metricName, AUTO_TUNE_STEP_MULTIPLIER, AUTO_TUNE_MAX_MULTIPLIER, now);

      await this.auditService
        .recordEvent({
          tenantId,
          actorId: null,
          action: "alert.auto_tuned",
          resourceType: "alert_auto_tune_state",
          resourceId: updated.id,
          details: { agentId: pattern.agentId, metricName: pattern.metricName, newWarningMultiplier: updated.warningMultiplier, falsePositiveCount: counts.falsePositiveCount },
          dataClassification: DataClassification.INTERNAL,
        })
        .catch((err) => this.logger.warn(`failed to record auto-tune audit event: ${err instanceof Error ? err.message : err}`));
    }
  }
}
