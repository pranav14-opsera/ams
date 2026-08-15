import type { ErrorCode } from "./error-codes.enum";

export interface ErrorResponse {
  error: ErrorCode;
  message: string;
  request_id: string;
  field?: string;
  details?: string[];
}

export interface ForbiddenErrorResponse extends ErrorResponse {
  error: ErrorCode.FORBIDDEN;
  required_permission: string;
  granting_roles: string[];
}

export interface RateLimitErrorResponse extends ErrorResponse {
  error: ErrorCode.RATE_LIMIT_EXCEEDED;
  retry_after: number;
}
