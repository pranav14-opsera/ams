import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { NoPermissionRequired } from "../rbac/no-permission-required.decorator";
import type { ScimPatchOpDto } from "./dto/scim-patch-op.dto";
import { ScimAuthGuard } from "./scim-auth.guard";
import { ScimGroupService, type ScimGroupCreatePayload } from "./scim-group.service";

@Controller("scim/v2/Groups")
@UseGuards(ScimAuthGuard)
@NoPermissionRequired()
export class ScimGroupController {
  constructor(private readonly scimGroupService: ScimGroupService) {}

  @Get()
  async list(@Req() req: Request) {
    return this.scimGroupService.list(req.tenantDbClient!, req.tenantId!);
  }

  @Get(":id")
  async get(@Param("id") id: string, @Req() req: Request) {
    return this.scimGroupService.get(req.tenantDbClient!, req.tenantId!, id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() payload: ScimGroupCreatePayload, @Req() req: Request) {
    return this.scimGroupService.create(req.tenantDbClient!, req.tenantId!, null, payload);
  }

  @Patch(":id")
  async patch(@Param("id") id: string, @Body() dto: ScimPatchOpDto, @Req() req: Request) {
    return this.scimGroupService.patchMembers(req.tenantDbClient!, req.tenantId!, null, id, dto.Operations ?? []);
  }
}
