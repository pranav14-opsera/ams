import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, Logger } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { DataClassification } from "../classification/data-classification.enum";
import { ErrorCode } from "../shared/errors/error-codes.enum";
import { getRequestId } from "../shared/errors/request-id";
import { AUDIT_SERVICE, type AuditServicePort } from "../tenants/ports/audit-service.port";
import { NO_PERMISSION_REQUIRED_KEY } from "./no-permission-required.decorator";
import { REQUIRE_ANY_PERMISSION_KEY } from "./require-any-permission.decorator";
import { REQUIRE_PERMISSION_KEY } from "./require-permission.decorator";
import { RESOURCE_TEAM_PARAM_KEY } from "./resource-team-param.decorator";
import { TeamMembershipRepository } from "./team-membership.repository";

const TEAM_SCOPED_ROLES = ["team_lead", "agent_operator"];

/** Carried on a denial's ForbiddenException response so RbacForbiddenExceptionFilter can recognize and enrich it — other guards' ForbiddenExceptions (e.g. MfaStepUpGuard's MFA_REQUIRED) are left untouched by that filter. */
export interface RbacDenialResponse {
  error: ErrorCode.FORBIDDEN;
  message: string;
  required_permission: string;
  request_id: string;
}

/**
 * The platform-wide, deny-by-default authorization gate (OWASP A01):
 * every route must declare @RequirePermission(...) or this guard denies
 * it outright. The allow/deny decision itself needs no database or cache
 * lookup at all — the caller's resolved permission set is already baked
 * into the JWT at mint time (WO-019/WO-023), and TenantContextMiddleware
 * (which runs before any guard) has already verified that token and
 * copied its `permissions`/`roles` claims onto the request. That keeps
 * this comfortably within the 200ms P95 budget without needing Redis on
 * the hot path — the only thing that DOES need a (cached) matrix lookup
 * is the "granting_roles" hint attached to a 403 response, which
 * RbacForbiddenExceptionFilter computes via RbacMatrixCacheService.
 */
@Injectable()
export class RbacGuard implements CanActivate {
  private readonly logger = new Logger(RbacGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly teamMembershipRepository: TeamMembershipRepository,
    @Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const noPermissionRequired = this.reflector.getAllAndOverride<boolean | undefined>(NO_PERMISSION_REQUIRED_KEY, [context.getHandler(), context.getClass()]);
    if (noPermissionRequired) return true;

    const requiredPermission = this.reflector.getAllAndOverride<string | undefined>(REQUIRE_PERMISSION_KEY, [context.getHandler(), context.getClass()]);
    const requireAnyPermission = this.reflector.getAllAndOverride<string[] | undefined>(REQUIRE_ANY_PERMISSION_KEY, [context.getHandler(), context.getClass()]);
    const req = context.switchToHttp().getRequest<Request>();

    if (!requiredPermission && !requireAnyPermission) {
      this.logger.warn(`security event: route ${req.method} ${req.originalUrl} has no @RequirePermission/@RequireAnyPermission decorator — denying by default`);
      await this.deny(req, "unknown", "no_permission_declared");
    }

    const grantedPermissions = req.permissions ?? [];
    if (requireAnyPermission) {
      if (!requireAnyPermission.some((p) => grantedPermissions.includes(p))) {
        await this.deny(req, requireAnyPermission.join(" OR "), "insufficient_permission");
      }
    } else if (!grantedPermissions.includes(requiredPermission!)) {
      await this.deny(req, requiredPermission!, "insufficient_permission");
    }

    const resourceTeamParam = this.reflector.getAllAndOverride<string | undefined>(RESOURCE_TEAM_PARAM_KEY, [context.getHandler(), context.getClass()]);
    const callerRoles = req.roles ?? [];
    const isTeamScopedCaller = callerRoles.some((role) => TEAM_SCOPED_ROLES.includes(role));

    if (resourceTeamParam && isTeamScopedCaller) {
      const resourceTeamId = req.params?.[resourceTeamParam];
      if (typeof resourceTeamId === "string" && resourceTeamId) {
        const userTeamIds = await this.teamMembershipRepository.getUserTeamIds(req.tenantId!, req.actorId!, req.tenantDbClient);
        if (!userTeamIds.includes(resourceTeamId)) {
          await this.deny(req, requiredPermission!, "cross_team_access");
        }
      }
    }

    return true;
  }

  private async deny(req: Request, requiredPermission: string, denialReason: string): Promise<never> {
    const requestId = getRequestId(req);

    await this.auditService
      .recordEvent({
        tenantId: req.tenantId ?? "unknown",
        actorId: req.actorId ?? null,
        action: "rbac.access_denied",
        resourceType: "route",
        resourceId: req.tenantId ?? "unknown",
        details: {
          requestedResource: req.originalUrl,
          requiredPermission,
          userRoles: req.roles ?? [],
          denialReason,
          ipAddress: req.ip ?? null,
          requestId,
        },
        dataClassification: DataClassification.CONFIDENTIAL,
      })
      .catch((err) => this.logger.error(`failed to record rbac.access_denied audit event: ${err instanceof Error ? err.message : err}`));

    const response: RbacDenialResponse = {
      error: ErrorCode.FORBIDDEN,
      message: `Permission ${requiredPermission} required.`,
      required_permission: requiredPermission,
      request_id: requestId,
    };
    throw new ForbiddenException(response);
  }
}
