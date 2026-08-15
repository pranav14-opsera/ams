import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { QualityScoreController } from "./quality-score.controller";
import { QualityScoreLockService } from "./quality-score-lock.service";
import { QualityScoreRepository } from "./quality-score.repository";
import { QualityScoreSchedulerService } from "./quality-score.scheduler.service";
import { QualityScoreService } from "./quality-score.service";

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [QualityScoreController],
  providers: [QualityScoreRepository, QualityScoreService, QualityScoreLockService, QualityScoreSchedulerService],
  exports: [QualityScoreRepository, QualityScoreService],
})
export class QualityScoreModule {}
