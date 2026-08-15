import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { AlertsModule } from "../alerts/alerts.module";
import { QualityScoreModule } from "../quality-score/quality-score.module";
import { DriftDetectionController } from "./drift-detection.controller";
import { DriftDetectionSchedulerService } from "./drift-detection.scheduler.service";
import { DriftDetectionService } from "./drift-detection.service";
import { DriftEventRepository } from "./drift-event.repository";
import { DriftStateCacheService } from "./drift-state-cache.service";
import { DriftStateRepository } from "./drift-state.repository";

@Module({
  imports: [ScheduleModule.forRoot(), AlertsModule, QualityScoreModule],
  controllers: [DriftDetectionController],
  providers: [DriftEventRepository, DriftStateRepository, DriftStateCacheService, DriftDetectionService, DriftDetectionSchedulerService],
  exports: [DriftEventRepository, DriftStateRepository],
})
export class DriftDetectionModule {}
