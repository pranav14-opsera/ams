import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { PermissionName } from "../rbac/rbac.constants";
import { RequirePermission } from "../rbac/require-permission.decorator";
import { CreateTeamDto } from "./dto/create-team.dto";
import { TeamsService } from "./teams.service";

/**
 * WO-080's Register New Agent wizard (Step 3: Assign Team) is this
 * route's only current caller — gated by AGENT_CREATE (not a new,
 * dedicated "team:read"/"team:create" permission) because that's exactly
 * the permission set that already limits who reaches this wizard in the
 * first place (per the RBAC seed, only platform_admin holds it —
 * database/migrations/024_rbac_permission_matrix.sql), matching this
 * WO's own "with the option to create a new team if the user has Admin
 * role" wording without inventing and re-seeding a new permission for a
 * single-consumer route.
 */
@Controller("api/v1/teams")
export class TeamsController {
  constructor(private readonly service: TeamsService) {}

  @Get()
  @RequirePermission(PermissionName.AGENT_CREATE)
  async list(@Req() req: Request) {
    const teams = await this.service.list(req.tenantDbClient, { tenantId: req.tenantId!, actorId: req.actorId ?? null, roles: req.roles ?? [] });
    return { teams };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission(PermissionName.AGENT_CREATE)
  async create(@Body() dto: CreateTeamDto, @Req() req: Request) {
    return this.service.create(req.tenantDbClient, { tenantId: req.tenantId!, actorId: req.actorId ?? null, roles: req.roles ?? [] }, dto.name);
  }
}
