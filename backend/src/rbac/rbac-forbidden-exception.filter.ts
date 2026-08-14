import { ArgumentsHost, Catch, ExceptionFilter, ForbiddenException } from "@nestjs/common";
import type { Response } from "express";
import { RbacMatrixCacheService } from "./rbac-matrix-cache.service";
import type { RbacDenialResponse } from "./rbac.guard";

function isRbacDenial(body: unknown): body is RbacDenialResponse {
  return typeof body === "object" && body !== null && (body as any).error === "FORBIDDEN" && typeof (body as any).required_permission === "string";
}

/**
 * Catches every ForbiddenException app-wide, but only reformats the ones
 * RbacGuard itself threw (recognized by its {error: "FORBIDDEN",
 * required_permission, request_id} shape) — enriching them with
 * granting_roles per this WO's acceptance criteria. Any OTHER
 * ForbiddenException (e.g. MfaStepUpGuard's {error: "MFA_REQUIRED", ...},
 * or the tenant-ownership checks in EncryptionController/GroupMappingController)
 * passes through completely unchanged.
 */
@Catch(ForbiddenException)
export class RbacForbiddenExceptionFilter implements ExceptionFilter {
  constructor(private readonly matrixCache: RbacMatrixCacheService) {}

  async catch(exception: ForbiddenException, host: ArgumentsHost): Promise<void> {
    const response = host.switchToHttp().getResponse<Response>();
    const body = exception.getResponse();

    if (!isRbacDenial(body)) {
      response.status(exception.getStatus()).json(body);
      return;
    }

    const grantingRoles = await this.matrixCache.getGrantingRoles(body.required_permission);
    response.status(exception.getStatus()).json({ ...body, granting_roles: grantingRoles });
  }
}
