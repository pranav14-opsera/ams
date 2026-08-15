import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { PermissionName } from "../rbac/rbac.constants";
import { RequirePermission } from "../rbac/require-permission.decorator";
import { AlertChannelConfigService } from "./alert-channel-config.service";
import { CreateEmailChannelConfigDto } from "./dto/create-email-channel-config.dto";
import { CreateWebhookConfigDto } from "./dto/create-webhook-config.dto";
import { TestChannelDto } from "./dto/test-channel.dto";

@Controller("api/v1/alerts/channels")
export class AlertChannelConfigController {
  constructor(private readonly service: AlertChannelConfigService) {}

  @Post("webhooks")
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission(PermissionName.ALERT_THRESHOLD_MANAGE)
  async createWebhook(@Body() dto: CreateWebhookConfigDto, @Req() req: Request) {
    return this.service.createWebhook(req.tenantId!, req.actorId ?? null, dto.url, dto.secret);
  }

  @Get("webhooks")
  @RequirePermission(PermissionName.AGENT_READ)
  async listWebhooks(@Req() req: Request) {
    return this.service.listWebhooks(req.tenantId!);
  }

  @Patch("webhooks/:id/enabled")
  @RequirePermission(PermissionName.ALERT_THRESHOLD_MANAGE)
  async setWebhookEnabled(@Param("id") id: string, @Body("enabled") enabled: boolean, @Req() req: Request) {
    await this.service.setWebhookEnabled(req.tenantId!, req.actorId ?? null, id, enabled);
  }

  @Delete("webhooks/:id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(PermissionName.ALERT_THRESHOLD_MANAGE)
  async deleteWebhook(@Param("id") id: string, @Req() req: Request) {
    await this.service.deleteWebhook(req.tenantId!, req.actorId ?? null, id);
  }

  @Post("email")
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission(PermissionName.ALERT_THRESHOLD_MANAGE)
  async createEmailChannel(@Body() dto: CreateEmailChannelConfigDto, @Req() req: Request) {
    return this.service.createEmailChannel(req.tenantId!, req.actorId ?? null, dto.recipients);
  }

  @Get("email")
  @RequirePermission(PermissionName.AGENT_READ)
  async listEmailChannels(@Req() req: Request) {
    return this.service.listEmailChannels(req.tenantId!);
  }

  @Post("test")
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PermissionName.ALERT_THRESHOLD_MANAGE)
  async testChannel(@Body() dto: TestChannelDto, @Req() req: Request) {
    return this.service.testChannel(req.tenantId!, dto.channelType, dto.configId);
  }
}
