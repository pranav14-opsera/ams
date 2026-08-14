import { Module } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { PhiScrubberService } from "./phi-scrubber.service";
import { PhiScrubberPipelineStage } from "./phi-scrubber-pipeline-stage";
import { PhiMaskingLogger } from "./phi-masking.middleware";
import { PhiErrorScrubberInterceptor } from "./phi-error-scrubber.interceptor";

@Module({
  providers: [
    PhiScrubberService,
    PhiScrubberPipelineStage,
    PhiMaskingLogger,
    // APP_INTERCEPTOR registers this globally for every route in the
    // application, not just ones that explicitly opt in — matching the
    // acceptance criteria's "any uncovered path where PHI could leak is
    // a HIPAA breach."
    { provide: APP_INTERCEPTOR, useClass: PhiErrorScrubberInterceptor },
  ],
  exports: [PhiScrubberService, PhiScrubberPipelineStage, PhiMaskingLogger],
})
export class PhiScrubberModule {}
