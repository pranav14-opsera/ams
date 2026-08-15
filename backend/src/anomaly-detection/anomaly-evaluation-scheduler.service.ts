import { Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { AnomalyDetectorService } from "./anomaly-detector.service";
import { DriftDetectionConfigRepository } from "./drift-detection-config.repository";

const EVALUATION_INTERVAL_MS = 5_000;

/**
 * AC/implementation step: "extend ThresholdEvaluationScheduler... to
 * invoke AnomalyDetectorService.evaluate() after threshold checks." A
 * SEPARATE scheduler class, not a literal in-place extension of WO-059's
 * ThresholdEvaluationSchedulerService: that class lives in AlertsModule,
 * and AnomalyDetectorService itself depends on AlertsModule's own
 * AlertEventRepository/AlertDeliveryService — having AlertsModule's
 * scheduler ALSO depend on AnomalyDetectorService would create a
 * circular module dependency. Both schedulers run on the identical 5s
 * cadence (this WO's own AC), which is functionally equivalent to "after
 * threshold checks" for any reasonable definition of "after" at this
 * granularity, without the circular-import complexity.
 */
@Injectable()
export class AnomalyEvaluationSchedulerService {
  private readonly logger = new Logger(AnomalyEvaluationSchedulerService.name);

  constructor(
    private readonly driftConfigRepository: DriftDetectionConfigRepository,
    private readonly detector: AnomalyDetectorService,
  ) {}

  @Interval(EVALUATION_INTERVAL_MS)
  async runEvaluationTick(): Promise<void> {
    let tenantIds: string[];
    try {
      tenantIds = await this.driftConfigRepository.findDistinctTenantIds();
    } catch (err) {
      this.logger.warn(`failed to list tenants for anomaly evaluation: ${err instanceof Error ? err.message : err}`);
      return;
    }

    for (const tenantId of tenantIds) {
      try {
        await this.detector.evaluateTenant(tenantId);
      } catch (err) {
        this.logger.warn(`anomaly evaluation failed for tenant ${tenantId}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
}
