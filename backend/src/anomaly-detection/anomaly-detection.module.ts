import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { AlertsModule } from "../alerts/alerts.module";
import { AnomalyBaselineRepository } from "./anomaly-baseline.repository";
import { AnomalyConfigController } from "./anomaly-config.controller";
import { AnomalyDetectorService } from "./anomaly-detector.service";
import { AnomalyEvaluationSchedulerService } from "./anomaly-evaluation-scheduler.service";
import { CalibrationService } from "./calibration.service";
import { DriftDetectionConfigRepository } from "./drift-detection-config.repository";
import { EwmaStateCacheService } from "./ewma-state-cache.service";

@Module({
  imports: [ScheduleModule.forRoot(), AlertsModule],
  controllers: [AnomalyConfigController],
  providers: [
    DriftDetectionConfigRepository,
    AnomalyBaselineRepository,
    CalibrationService,
    EwmaStateCacheService,
    AnomalyDetectorService,
    AnomalyEvaluationSchedulerService,
  ],
  exports: [DriftDetectionConfigRepository, AnomalyBaselineRepository, CalibrationService],
})
export class AnomalyDetectionModule {}
