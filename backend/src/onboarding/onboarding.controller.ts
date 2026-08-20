import { Body, Controller, ForbiddenException, Get, NotFoundException, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { PermissionName } from "../rbac/rbac.constants";
import { RequirePermission } from "../rbac/require-permission.decorator";
import { SaveOnboardingProgressDto } from "./dto/save-onboarding-progress.dto";
import { OnboardingService } from "./onboarding.service";

/**
 * api_contracts describes these as flat `/api/v1/onboarding/{tenantId}/...`
 * routes; kept exactly as specified (unlike SsoConfigController/
 * ScimTokenController's `/api/v1/tenants/:tenantId/...` convention)
 * because this WO's own api_contracts section is explicit about the
 * literal path, and nothing else in the codebase already claims
 * `/api/v1/onboarding`.
 *
 * Gated by TENANT_SETTINGS_MANAGE — the closest existing permission to
 * "manage this tenant's own setup," reused rather than minting a new
 * `onboarding:*` permission (which would require touching
 * rbac.constants.ts, a seed migration, AND docs/rbac-permission-matrix.md
 * — see WO-023's own three-way-sync test — for a single-controller
 * concern that TENANT_SETTINGS_MANAGE already covers).
 */
@Controller("api/v1/onboarding/:tenantId")
export class OnboardingController {
  constructor(private readonly service: OnboardingService) {}

  @Post("progress")
  @RequirePermission(PermissionName.TENANT_SETTINGS_MANAGE)
  async saveProgress(@Param("tenantId") tenantId: string, @Body() dto: SaveOnboardingProgressDto, @Req() req: Request) {
    this.requireOwnTenant(tenantId, req);
    const progress = await this.service.saveProgress(
      req.tenantDbClient!,
      tenantId,
      req.actorId ?? null,
      dto.currentStep,
      dto.stepData,
      dto.completedSteps,
    );
    return { saved: true, updatedAt: progress.updatedAt.toISOString() };
  }

  @Get("progress")
  @RequirePermission(PermissionName.TENANT_SETTINGS_MANAGE)
  async getProgress(@Param("tenantId") tenantId: string, @Req() req: Request) {
    this.requireOwnTenant(tenantId, req);
    const result = await this.service.getProgress(req.tenantDbClient!, tenantId);
    if (!result) {
      throw new NotFoundException("No onboarding session exists for this tenant.");
    }
    if (result.expired) {
      // edge_case: expired session — a distinct, structured shape (not a
      // thrown error) so the wizard can render "your onboarding session
      // has expired" rather than a generic failure banner.
      return { expired: true, expiresAt: result.expiresAt.toISOString() };
    }
    return {
      expired: false,
      currentStep: result.progress.currentStep,
      stepData: result.progress.stepData,
      completedSteps: result.progress.completedSteps,
      createdAt: result.progress.createdAt.toISOString(),
      expiresAt: result.progress.expiresAt.toISOString(),
    };
  }

  @Post("restart")
  @RequirePermission(PermissionName.TENANT_SETTINGS_MANAGE)
  async restart(@Param("tenantId") tenantId: string, @Req() req: Request) {
    this.requireOwnTenant(tenantId, req);
    await this.service.restart(req.tenantDbClient!, tenantId);
    return { restarted: true };
  }

  @Get("status")
  @RequirePermission(PermissionName.TENANT_SETTINGS_MANAGE)
  async getStatus(@Param("tenantId") tenantId: string, @Req() req: Request) {
    this.requireOwnTenant(tenantId, req);
    return this.service.getStatus(req.tenantDbClient!, tenantId);
  }

  private requireOwnTenant(tenantId: string, req: Request): void {
    if (req.tenantId !== tenantId) {
      throw new ForbiddenException("Cannot manage onboarding for another tenant.");
    }
  }
}
