import { Injectable } from "@nestjs/common";
import { PhiScrubberService } from "./phi-scrubber.service";

/**
 * WO-043 defense-in-depth: re-scans output that the primary PhiScrubberService
 * pass (WO-017) has ALREADY masked, to catch anything that pass missed —
 * e.g. a tenant PHI-pattern override added after the primary pass ran, or a
 * bug in a future pattern change. This is not "run the same scrub again and
 * expect it to do something different" — it's the platform's own explicit
 * quarantine gate: if this pass still finds PHI-shaped content, the event
 * must never reach Kafka, full stop.
 */
@Injectable()
export class PhiSecondaryValidator {
  constructor(private readonly phiScrubber: PhiScrubberService) {}

  /** True if PHI-shaped content still exists in already-scrubbed metadata. */
  hasResidualPhi(scrubbedMetadata: Record<string, unknown>, tenantSettings?: Record<string, unknown> | null): boolean {
    const rescrubbedFields = this.phiScrubber.scrub(scrubbedMetadata, tenantSettings);
    if (JSON.stringify(rescrubbedFields) !== JSON.stringify(scrubbedMetadata)) return true;

    // scrubEmbeddedText() (not a raw scrubText() over the whole
    // JSON.stringify()'d document) — WO-044 found that applying the
    // unanchored substring regex to an entire serialized document can
    // match digits inside an unquoted JSON NUMBER (e.g. a millisecond
    // timestamp), which would make this re-scrub always "change"
    // something and falsely quarantine every event carrying one.
    const rescrubbedText = this.phiScrubber.scrubEmbeddedText(scrubbedMetadata, tenantSettings);
    return JSON.stringify(rescrubbedText) !== JSON.stringify(scrubbedMetadata);
  }
}
