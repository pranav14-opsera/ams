import { Body, Controller, ForbiddenException, HttpCode, HttpStatus, NotFoundException, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { NoPermissionRequired } from "../rbac/no-permission-required.decorator";
import { AdapterRegistryService } from "./adapter-registry.service";
import { TelemetryPipelineService } from "./pipeline/telemetry-pipeline.service";

@Controller("api/v1/adapters")
export class AdaptersController {
  constructor(
    private readonly registry: AdapterRegistryService,
    private readonly pipeline: TelemetryPipelineService,
  ) {}

  // HmacValidationMiddleware (not RbacGuard) is the authentication gate
  // here — a telemetry submission has no user session/JWT at all, so
  // there is no platform permission to require.
  @Post(":frameworkType/telemetry")
  @HttpCode(HttpStatus.ACCEPTED)
  @NoPermissionRequired()
  async ingestTelemetry(@Param("frameworkType") frameworkType: string, @Body() rawEvent: unknown, @Req() req: Request) {
    const adapter = this.registry.get(frameworkType);
    if (!adapter) {
      throw new NotFoundException(`No adapter is registered for framework type "${frameworkType}".`);
    }

    const canonicalEvent = adapter.translateTelemetry(rawEvent);

    // Defense in depth: never trust the raw payload's own claimed
    // agent_id/tenant_id as authorization — it must match the identity
    // HmacValidationMiddleware already authenticated via the shared
    // secret, or this is either a misconfigured adapter or a forged event.
    if (canonicalEvent.agent_id !== req.telemetryAgentId || canonicalEvent.tenant_id !== req.tenantId) {
      throw new ForbiddenException("Telemetry event does not match the authenticated agent.");
    }

    return this.pipeline.process(undefined, canonicalEvent);
  }
}
