import { Module } from "@nestjs/common";
import { AUDIT_SERVICE } from "../tenants/ports/audit-service.port";
import { PostgresAuditService } from "../tenants/ports/postgres/postgres-audit.service";
import { OnboardingController } from "./onboarding.controller";
import { OnboardingProgressRepository } from "./onboarding-progress.repository";
import { OnboardingService } from "./onboarding.service";

@Module({
  controllers: [OnboardingController],
  providers: [OnboardingProgressRepository, OnboardingService, { provide: AUDIT_SERVICE, useClass: PostgresAuditService }],
  exports: [OnboardingService],
})
export class OnboardingModule {}
