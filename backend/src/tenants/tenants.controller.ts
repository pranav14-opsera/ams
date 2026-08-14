import { Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, Patch, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { CreateTenantDto } from "./dto/create-tenant.dto";
import { UpdateTenantSettingsDto } from "./dto/update-tenant-settings.dto";
import { TenantsService } from "./tenants.service";

@Controller("api/v1/tenants")
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateTenantDto, @Req() req: Request) {
    return this.tenantsService.create(dto, req.actorId ?? null);
  }

  @Get(":id")
  async findOne(@Param("id") id: string, @Req() req: Request) {
    if (!req.tenantId) {
      throw new NotFoundException(`Tenant ${id} not found.`);
    }
    return this.tenantsService.findScoped(id, req.tenantId, req.tenantDbClient);
  }

  @Patch(":id/settings")
  async updateSettings(@Param("id") id: string, @Body() dto: UpdateTenantSettingsDto, @Req() req: Request) {
    if (!req.tenantId || !req.tenantDbClient) {
      throw new NotFoundException(`Tenant ${id} not found.`);
    }
    return this.tenantsService.updateSettingsScoped(id, req.tenantId, dto.settings, req.actorId ?? null, req.tenantDbClient);
  }
}
