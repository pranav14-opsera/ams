import { Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, Patch, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { NoPermissionRequired } from "../rbac/no-permission-required.decorator";
import { PermissionName } from "../rbac/rbac.constants";
import { RequirePermission } from "../rbac/require-permission.decorator";
import { CreateTenantDto } from "./dto/create-tenant.dto";
import { UpdateTenantSettingsDto } from "./dto/update-tenant-settings.dto";
import { TenantsService } from "./tenants.service";

@Controller("api/v1/tenants")
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  // Brand-new tenant creation happens before any of THAT tenant's users or
  // roles exist — it's a platform-ops action outside the 5-tenant-role
  // WO-023 matrix entirely (which is scoped to an EXISTING tenant's own
  // users), not a gap in this guard's coverage.
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @NoPermissionRequired()
  async create(@Body() dto: CreateTenantDto, @Req() req: Request) {
    return this.tenantsService.create(dto, req.actorId ?? null);
  }

  @Get(":id")
  @RequirePermission(PermissionName.TENANT_SETTINGS_MANAGE)
  async findOne(@Param("id") id: string, @Req() req: Request) {
    if (!req.tenantId) {
      throw new NotFoundException(`Tenant ${id} not found.`);
    }
    return this.tenantsService.findScoped(id, req.tenantId, req.tenantDbClient);
  }

  @Patch(":id/settings")
  @RequirePermission(PermissionName.TENANT_SETTINGS_MANAGE)
  async updateSettings(@Param("id") id: string, @Body() dto: UpdateTenantSettingsDto, @Req() req: Request) {
    if (!req.tenantId || !req.tenantDbClient) {
      throw new NotFoundException(`Tenant ${id} not found.`);
    }
    return this.tenantsService.updateSettingsScoped(id, req.tenantId, dto.settings, req.actorId ?? null, req.tenantDbClient);
  }
}
