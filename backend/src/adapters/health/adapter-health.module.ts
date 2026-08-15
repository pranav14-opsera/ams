import { Module } from "@nestjs/common";
import { AdaptersModule } from "../adapters.module";
import { AdapterConfigurationRepository } from "./adapter-configuration.repository";
import { AdapterHealthCheckRepository } from "./adapter-health-check.repository";
import { AdapterHealthController } from "./adapter-health.controller";
import { AdapterHealthSchedulerService } from "./adapter-health-scheduler.service";
import { AdapterHealthService } from "./adapter-health.service";

@Module({
  imports: [AdaptersModule],
  controllers: [AdapterHealthController],
  providers: [AdapterConfigurationRepository, AdapterHealthCheckRepository, AdapterHealthService, AdapterHealthSchedulerService],
  exports: [AdapterHealthService, AdapterConfigurationRepository],
})
export class AdapterHealthModule {}
