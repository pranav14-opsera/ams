import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { NoPermissionRequired } from "../rbac/no-permission-required.decorator";
import type { ScimPatchOpDto } from "./dto/scim-patch-op.dto";
import { ScimAuthGuard } from "./scim-auth.guard";
import type { ScimUserCreatePayload } from "./scim-user.mapper";
import { ScimUserService } from "./scim-user.service";

@Controller("scim/v2/Users")
@UseGuards(ScimAuthGuard)
@NoPermissionRequired()
export class ScimUserController {
  constructor(private readonly scimUserService: ScimUserService) {}

  @Get()
  async list(@Query("filter") filter: string | undefined, @Query("startIndex") startIndex: string | undefined, @Query("count") count: string | undefined, @Req() req: Request) {
    return this.scimUserService.list(req.tenantDbClient!, req.tenantId!, filter, Number(startIndex ?? 1), Number(count ?? 100));
  }

  @Get(":id")
  async get(@Param("id") id: string, @Req() req: Request) {
    return this.scimUserService.get(req.tenantDbClient!, req.tenantId!, id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() payload: ScimUserCreatePayload, @Req() req: Request) {
    return this.scimUserService.create(req.tenantDbClient!, req.tenantId!, null, payload);
  }

  @Put(":id")
  async replace(@Param("id") id: string, @Body() payload: ScimUserCreatePayload, @Req() req: Request) {
    return this.scimUserService.replace(req.tenantDbClient!, req.tenantId!, null, id, payload);
  }

  @Patch(":id")
  async patch(@Param("id") id: string, @Body() dto: ScimPatchOpDto, @Req() req: Request) {
    return this.scimUserService.patch(req.tenantDbClient!, req.tenantId!, null, id, dto.Operations ?? []);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  async deactivate(@Param("id") id: string, @Req() req: Request) {
    await this.scimUserService.deactivate(req.tenantDbClient!, req.tenantId!, null, id);
  }
}
