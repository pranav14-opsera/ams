import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { PermissionName } from "../rbac/rbac.constants";
import { RequirePermission } from "../rbac/require-permission.decorator";
import { AgentsService } from "./agents.service";
import { CreateAgentDto } from "./dto/create-agent.dto";
import { ListAgentsQueryDto } from "./dto/list-agents-query.dto";
import { UpdateAgentDto } from "./dto/update-agent.dto";

@Controller("api/v1/agents")
export class AgentsController {
  constructor(private readonly agentsService: AgentsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission(PermissionName.AGENT_CREATE)
  async create(@Body() dto: CreateAgentDto, @Req() req: Request) {
    return this.agentsService.create(req.tenantDbClient, req.tenantId!, req.actorId ?? null, dto);
  }

  @Get()
  @RequirePermission(PermissionName.AGENT_READ)
  async findAll(@Query() query: ListAgentsQueryDto, @Req() req: Request) {
    return this.agentsService.findAll(req.tenantDbClient, req.tenantId!, query);
  }

  @Get(":id")
  @RequirePermission(PermissionName.AGENT_READ)
  async findOne(@Param("id") id: string, @Req() req: Request) {
    return this.agentsService.findOne(req.tenantDbClient, req.tenantId!, id);
  }

  @Patch(":id")
  @RequirePermission(PermissionName.AGENT_UPDATE)
  async update(@Param("id") id: string, @Body() dto: UpdateAgentDto, @Req() req: Request) {
    return this.agentsService.update(req.tenantDbClient, req.tenantId!, req.actorId ?? null, id, dto);
  }

  @Delete(":id")
  @RequirePermission(PermissionName.AGENT_DELETE)
  async remove(@Param("id") id: string, @Req() req: Request) {
    return this.agentsService.remove(req.tenantDbClient, req.tenantId!, req.actorId ?? null, id);
  }
}
