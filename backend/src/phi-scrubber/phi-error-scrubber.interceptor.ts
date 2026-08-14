import { HttpException, Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from "@nestjs/common";
import { Observable, catchError, map, throwError } from "rxjs";
import { PhiScrubberService } from "./phi-scrubber.service";

// Named after the acceptance criteria's error-scrubbing requirement, but
// scrubs BOTH the success path (map) and the error path (catchError):
// this WO also requires "Trace display data served via API has all PHI
// fields masked... while preserving non-PHI trace structure" — a
// successful 200 response can carry PHI just as easily as a thrown
// exception's detail fields can, and there is no trace-display endpoint
// built yet to special-case around, so scrubbing every response body
// globally is what actually satisfies both requirements without
// depending on a future endpoint remembering to opt in.
@Injectable()
export class PhiErrorScrubberInterceptor implements NestInterceptor {
  constructor(private readonly phiScrubber: PhiScrubberService) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      map((body) => this.scrubBody(body)),
      catchError((err: unknown) => {
        if (err instanceof HttpException) {
          const status = err.getStatus();
          const scrubbedResponse = this.scrubBody(err.getResponse());
          const scrubbedMessage = typeof err.message === "string" ? this.phiScrubber.scrubText(err.message) : err.message;
          const scrubbed = new HttpException(scrubbedResponse as string | Record<string, unknown>, status, { cause: err.cause });
          // getResponse() already carries the scrubbed message when the
          // original response was an object; when it was a plain string,
          // HttpException's constructor reuses it as .message too, so
          // reassign explicitly to guarantee the plain-string case is
          // scrubbed the same way.
          Object.defineProperty(scrubbed, "message", { value: scrubbedMessage, enumerable: false });
          return throwError(() => scrubbed);
        }
        // A non-HTTP error (e.g. an unhandled Error from deep in a
        // service) — scrub its message too before it potentially ends up
        // serialized by a downstream exception filter.
        if (err instanceof Error) {
          err.message = this.phiScrubber.scrubText(err.message);
        }
        return throwError(() => err);
      }),
    );
  }

  private scrubBody(body: unknown): unknown {
    if (typeof body === "string") return this.phiScrubber.scrubText(body);
    if (typeof body === "object" && body !== null) return this.phiScrubber.scrub(body);
    return body;
  }
}
