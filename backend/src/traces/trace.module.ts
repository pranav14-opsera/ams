import { Module } from "@nestjs/common";
import { PhiScrubberModule } from "../phi-scrubber/phi-scrubber.module";
import { TraceRepository } from "./trace.repository";
import { TraceService } from "./trace.service";

@Module({
  imports: [PhiScrubberModule],
  providers: [TraceRepository, TraceService],
  exports: [TraceRepository, TraceService],
})
export class TraceModule {}
