import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";
import type { Pool } from "pg";
import { PG_POOL } from "./common/database/database.module";
import { NoPermissionRequired } from "./rbac/no-permission-required.decorator";

// Matches the health-check path convention every service on this platform
// uses (see infrastructure/terraform/kubernetes' Helm chart base, WO-001)
// — real business controllers land in their own work orders.
@Controller("health")
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get("live")
  @NoPermissionRequired()
  live(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("ready")
  @NoPermissionRequired()
  ready(): { status: "ok" } {
    return { status: "ok" };
  }

  // WO-026's Kubernetes startup probe: unlike /live (process is up) or
  // /ready (accepting traffic), this checks the ONE dependency that must
  // be reachable before this service can do anything useful at all — the
  // database — so a slow-to-connect Postgres doesn't get misread as a
  // crashed container and killed by kubelet before it ever had a chance.
  @Get("startup")
  @NoPermissionRequired()
  async startup(): Promise<{ status: "ok" }> {
    try {
      await this.pool.query("SELECT 1");
      return { status: "ok" };
    } catch (err) {
      throw new ServiceUnavailableException({ status: "not_ready", reason: "database unreachable" });
    }
  }
}
