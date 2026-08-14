import { ConsoleLogger, Injectable, type LoggerService } from "@nestjs/common";
import { PhiScrubberService } from "./phi-scrubber.service";

// Wraps Nest's own ConsoleLogger, scrubbing every argument before
// delegating to it, so PHI never reaches whatever transport the real
// logger writes to (console today; a log aggregation pipeline in a real
// deployment) — installed via app.useLogger() in main.ts, which replaces
// Nest's logger globally for every framework-internal and application
// log call, not just ones a developer remembers to route through this
// class explicitly.
@Injectable()
export class PhiMaskingLogger extends ConsoleLogger implements LoggerService {
  constructor(private readonly phiScrubber: PhiScrubberService) {
    super();
  }

  override log(message: unknown, ...optionalParams: unknown[]): void {
    super.log(this.scrubArg(message), ...this.scrubArgs(optionalParams));
  }

  override error(message: unknown, ...optionalParams: unknown[]): void {
    super.error(this.scrubArg(message), ...this.scrubArgs(optionalParams));
  }

  override warn(message: unknown, ...optionalParams: unknown[]): void {
    super.warn(this.scrubArg(message), ...this.scrubArgs(optionalParams));
  }

  override debug(message: unknown, ...optionalParams: unknown[]): void {
    super.debug(this.scrubArg(message), ...this.scrubArgs(optionalParams));
  }

  override verbose(message: unknown, ...optionalParams: unknown[]): void {
    super.verbose(this.scrubArg(message), ...this.scrubArgs(optionalParams));
  }

  private scrubArg(value: unknown): unknown {
    if (typeof value === "string") return this.phiScrubber.scrubText(value);
    if (typeof value === "object" && value !== null) return this.phiScrubber.scrub(value);
    return value;
  }

  private scrubArgs(values: unknown[]): unknown[] {
    return values.map((v) => this.scrubArg(v));
  }
}
