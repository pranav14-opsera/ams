// WO-029's canonical error code contract — every error response across
// every NestJS service in this platform uses one of these, lowercase
// snake_case exactly as this WO's own acceptance criteria specify.
export enum ErrorCode {
  VALIDATION_ERROR = "validation_error",
  AUTHENTICATION_REQUIRED = "authentication_required",
  TOKEN_EXPIRED = "token_expired",
  FORBIDDEN = "forbidden",
  NOT_FOUND = "not_found",
  CONFLICT = "conflict",
  UNPROCESSABLE = "unprocessable",
  RATE_LIMIT_EXCEEDED = "rate_limit_exceeded",
  INTERNAL_ERROR = "internal_error",
  SERVICE_UNAVAILABLE = "service_unavailable",
}
