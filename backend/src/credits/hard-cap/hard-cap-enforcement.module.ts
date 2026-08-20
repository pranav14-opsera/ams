import { Module } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { AgentsModule } from "../../agents/agents.module";
import { AlertsModule } from "../../alerts/alerts.module";
import { CreditBudgetModule } from "../budget/credit-budget.module";
import { HardCapEnforcementService } from "./hard-cap-enforcement.service";
import { HardCapPauseStateRepository } from "./hard-cap-pause-state.repository";
import { HardCapResumeSchedulerService } from "./hard-cap-resume.scheduler.service";

@Module({
  imports: [ScheduleModule.forRoot(), AgentsModule, AlertsModule, CreditBudgetModule],
  providers: [HardCapPauseStateRepository, HardCapEnforcementService, HardCapResumeSchedulerService],
  exports: [HardCapPauseStateRepository, HardCapEnforcementService],
})
export class HardCapEnforcementModule {}
