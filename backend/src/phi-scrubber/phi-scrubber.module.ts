import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { PostgresAuditService } from "../tenants/ports/postgres/postgres-audit.service";
import { AUDIT_SERVICE } from "../tenants/ports/audit-service.port";
import { PhiAuditEmitter } from "./phi-audit-emitter";
import { PhiQuarantineRepository } from "./phi-quarantine.repository";
import { PhiScrubberService } from "./phi-scrubber.service";
import { PhiScrubberPipelineStage } from "./phi-scrubber-pipeline-stage";
import { PhiSecondaryValidator } from "./phi-secondary-validator";
import { PhiMaskingLogger } from "./phi-masking.middleware";
import { PhiErrorScrubberInterceptor } from "./phi-error-scrubber.interceptor";

@Module({
  providers: [
    PhiScrubberService,
    PhiScrubberPipelineStage,
    PhiMaskingLogger,
    PhiSecondaryValidator,
    PhiAuditEmitter,
    PhiQuarantineRepository,
    // AUDIT_SERVICE isn't exported from a shared module in this codebase
    // (tenants.module.ts/agents.module.ts each re-provide it locally too)
    // — PhiAuditEmitter needs its own binding for the same reason.
    { provide: AUDIT_SERVICE, useClass: PostgresAuditService },
    // APP_INTERCEPTOR registers this globally for every route in the
    // application, not just ones that explicitly opt in — matching the
    // acceptance criteria's "any uncovered path where PHI could leak is
    // a HIPAA breach."
    { provide: APP_INTERCEPTOR, useClass: PhiErrorScrubberInterceptor },
  ],
  exports: [PhiScrubberService, PhiScrubberPipelineStage, PhiMaskingLogger, PhiSecondaryValidator, PhiAuditEmitter, PhiQuarantineRepository],
})
export class PhiScrubberModule {}
