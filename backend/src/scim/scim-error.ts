import { BadRequestException, ConflictException, HttpStatus, NotFoundException, UnauthorizedException } from "@nestjs/common";

const SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";

/** RFC 7644 §3.12 error response body. */
export function scimErrorBody(status: HttpStatus, detail: string, scimType?: string) {
  return { schemas: [SCIM_ERROR_SCHEMA], detail, status: String(status), ...(scimType ? { scimType } : {}) };
}

export function scimBadRequest(detail: string, scimType?: string): BadRequestException {
  return new BadRequestException(scimErrorBody(HttpStatus.BAD_REQUEST, detail, scimType));
}

export function scimNotFound(detail: string): NotFoundException {
  return new NotFoundException(scimErrorBody(HttpStatus.NOT_FOUND, detail));
}

export function scimConflict(detail: string): ConflictException {
  return new ConflictException(scimErrorBody(HttpStatus.CONFLICT, detail, "uniqueness"));
}

export function scimUnauthorized(detail: string): UnauthorizedException {
  return new UnauthorizedException(scimErrorBody(HttpStatus.UNAUTHORIZED, detail));
}
