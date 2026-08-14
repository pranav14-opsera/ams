import { Controller, Get } from "@nestjs/common";

// Matches the health-check path convention every service on this platform
// uses (see infrastructure/terraform/kubernetes' Helm chart base, WO-001)
// — real business controllers land in their own work orders.
@Controller("health")
export class HealthController {
  @Get("live")
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("ready")
  ready(): { status: "ok" } {
    return { status: "ok" };
  }
}
