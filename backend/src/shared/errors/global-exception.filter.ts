import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from "@nestjs/common";
import type { Request, Response } from "express";
import { ErrorCode } from "./error-codes.enum";
import type { ErrorResponse } from "./error-response.interface";
import { getRequestId } from "./request-id";

const STATUS_TO_ERROR_CODE: Partial<Record<number, ErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: ErrorCode.VALIDATION_ERROR,
  [HttpStatus.UNAUTHORIZED]: ErrorCode.AUTHENTICATION_REQUIRED,
  [HttpStatus.FORBIDDEN]: ErrorCode.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ErrorCode.NOT_FOUND,
  [HttpStatus.CONFLICT]: ErrorCode.CONFLICT,
  [HttpStatus.UNPROCESSABLE_ENTITY]: ErrorCode.UNPROCESSABLE,
  [HttpStatus.TOO_MANY_REQUESTS]: ErrorCode.RATE_LIMIT_EXCEEDED,
  [HttpStatus.SERVICE_UNAVAILABLE]: ErrorCode.SERVICE_UNAVAILABLE,
};

/**
 * The platform-wide fallback error contract (WO-029). Registered as the
 * LAST global filter (see app.module.ts's import order) so more
 * specific filters that already own their own intentional shape —
 * RbacForbiddenExceptionFilter's granting_roles enrichment,
 * MfaStepUpGuard's MFA_REQUIRED body — get first refusal on exceptions
 * they recognize; this filter only ever sees what nothing more specific
 * already handled. PHI scrubbing already happened upstream
 * (PhiErrorScrubberInterceptor, WO-017) by the time anything reaches
 * here — this filter's job is the response SHAPE, not re-scrubbing.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();

    try {
      // SCIM (WO-025) has its own RFC 7644 error contract
      // ({schemas, detail, status}) — a completely different, equally
      // intentional shape this filter must not graft its own fields
      // onto, the same reasoning RbacForbiddenExceptionFilter already
      // applies to MfaStepUpGuard's distinct shape.
      if (req.path?.startsWith("/scim/v2") && exception instanceof HttpException) {
        res.status(exception.getStatus()).json(exception.getResponse());
        return;
      }

      const { status, body } = this.buildResponse(exception, req);
      this.logInternal(exception, req, status);
      res.status(status).json(body);
    } catch (filterError) {
      // This filter must never itself become the unhandled exception —
      // a hardcoded, guaranteed-valid fallback if anything above throws.
      this.logger.error(`GlobalExceptionFilter itself failed: ${filterError instanceof Error ? filterError.stack : filterError}`);
      res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        error: ErrorCode.INTERNAL_ERROR,
        message: "An unexpected error occurred.",
        request_id: "unknown",
      });
    }
  }

  private buildResponse(exception: unknown, req: Request): { status: number; body: ErrorResponse } {
    const requestId = getRequestId(req);

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const errorCode = STATUS_TO_ERROR_CODE[status] ?? (status >= 500 ? ErrorCode.INTERNAL_ERROR : ErrorCode.VALIDATION_ERROR);
      const rawResponse = exception.getResponse();

      if (errorCode === ErrorCode.VALIDATION_ERROR && this.isValidationPipeShape(rawResponse)) {
        return { status, body: this.buildValidationErrorBody(rawResponse, requestId) };
      }

      // Already-structured bodies (e.g. from services that throw
      // HttpException with their own object payload) are passed through
      // with error/request_id normalized onto WO-029's contract, so a
      // caller always sees the same top-level shape regardless of which
      // service produced it.
      if (typeof rawResponse === "object" && rawResponse !== null) {
        return { status, body: { message: exception.message, ...rawResponse, error: errorCode, request_id: requestId } as ErrorResponse };
      }

      return { status, body: { error: errorCode, message: exception.message, request_id: requestId } };
    }

    // Anything that isn't an HttpException at all — a raw thrown Error,
    // a rejected promise with a non-Error value, whatever — is always
    // an internal_error 500. Never reflects the original message back
    // to the caller (it could contain a stack, a file path, a DB
    // connection string); a generic message is deliberate here, not an
    // oversight.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: { error: ErrorCode.INTERNAL_ERROR, message: "An unexpected error occurred.", request_id: requestId },
    };
  }

  private isValidationPipeShape(response: unknown): response is { message: string[] | string; error?: string } {
    return typeof response === "object" && response !== null && "message" in response;
  }

  private buildValidationErrorBody(response: { message: string[] | string }, requestId: string): ErrorResponse {
    const messages = Array.isArray(response.message) ? response.message : [response.message];
    const body: ErrorResponse = { error: ErrorCode.VALIDATION_ERROR, message: "Validation failed.", request_id: requestId };

    if (messages.length === 1) {
      body.message = messages[0];
      const field = this.extractFieldName(messages[0]);
      if (field) body.field = field;
    } else if (messages.length > 1) {
      body.details = messages;
    }

    return body;
  }

  /** class-validator's default messages read "<field> <constraint text>" (e.g. "email must be an email") — best-effort extraction, omitted entirely (an optional field) when the shape doesn't match. */
  private extractFieldName(message: string): string | undefined {
    const match = /^(\w+) /.exec(message);
    return match?.[1];
  }

  private logInternal(exception: unknown, req: Request, status: number): void {
    const context = {
      requestId: getRequestId(req),
      actorId: req.actorId ?? null,
      tenantId: req.tenantId ?? null,
      resource: req.originalUrl,
      operation: req.method,
      status,
    };

    if (status >= 500) {
      this.logger.error(`Unhandled error [${JSON.stringify(context)}]: ${exception instanceof Error ? exception.stack : String(exception)}`);
    } else {
      this.logger.warn(`Request error [${JSON.stringify(context)}]: ${exception instanceof Error ? exception.message : String(exception)}`);
    }
  }
}
