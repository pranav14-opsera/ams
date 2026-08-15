import { Controller, Get, Param } from "@nestjs/common";
import { PermissionName } from "../../rbac/rbac.constants";
import { RequirePermission } from "../../rbac/require-permission.decorator";
import { AdapterHealthService } from "./adapter-health.service";

@Controller("api/v1/adapters")
export class AdapterHealthController {
  constructor(private readonly healthService: AdapterHealthService) {}

  @Get("compatibility")
  @RequirePermission(PermissionName.AGENT_READ)
  async getCompatibilityMatrix() {
    return { adapters: await this.healthService.getCompatibilityMatrix() };
  }

  @Get(":type/health")
  @RequirePermission(PermissionName.AGENT_READ)
  async getHealth(@Param("type") type: string) {
    return this.healthService.getAdapterHealth(type);
  }
}
