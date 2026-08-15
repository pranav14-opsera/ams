import { BadRequestException, Body, Controller, ForbiddenException, HttpCode, HttpStatus, Inject, NotFoundException, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import type { Pool } from "pg";
import { PG_POOL } from "../common/database/database.module";
import { NoPermissionRequired } from "../rbac/no-permission-required.decorator";
import { AdapterRegistryService } from "./adapter-registry.service";
import type { IAgentAdapter } from "./interfaces/agent-adapter.interface";
import { TelemetryPipelineService, type TelemetryPipelineResult } from "./pipeline/telemetry-pipeline.service";

// AC (WO-036): "batch-event submission... max 100 events per batch" —
// applied generically here (an HTTP-layer concern, not framework-
// specific) rather than only for the REST adapter's own route, since
// every framework shares this one controller and the single-event path
// below is completely unchanged for callers that never send an array.
const MAX_BATCH_SIZE = 100;

interface BatchItemResult {
  status: "accepted" | "rejected";
  result?: TelemetryPipelineResult;
  error?: string;
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "getResponse" in err) {
    const response = (err as { getResponse: () => unknown }).getResponse();
    if (response && typeof response === "object" && "message" in response) {
      const message = (response as { message: unknown }).message;
      if (typeof message === "string") return message;
      if (Array.isArray(message)) return message.join("; ");
    }
  }
  return err instanceof Error ? err.message : "Unknown error";
}

@Controller("api/v1/adapters")
export class AdaptersController {
  constructor(
    private readonly registry: AdapterRegistryService,
    private readonly pipeline: TelemetryPipelineService,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  // HmacValidationMiddleware (not RbacGuard) is the authentication gate
  // here — a telemetry submission has no user session/JWT at all, so
  // there is no platform permission to require.
  @Post(":frameworkType/telemetry")
  @HttpCode(HttpStatus.ACCEPTED)
  @NoPermissionRequired()
  async ingestTelemetry(@Param("frameworkType") frameworkType: string, @Body() rawBody: unknown, @Req() req: Request) {
    const adapter = this.registry.get(frameworkType);
    if (!adapter) {
      throw new NotFoundException(`No adapter is registered for framework type "${frameworkType}".`);
    }

    if (!Array.isArray(rawBody)) {
      return this.processOne(adapter, rawBody, req);
    }

    if (rawBody.length > MAX_BATCH_SIZE) {
      throw new BadRequestException(`A batch may contain at most ${MAX_BATCH_SIZE} events (received ${rawBody.length}).`);
    }

    const results: BatchItemResult[] = await Promise.all(
      rawBody.map(async (rawEvent): Promise<BatchItemResult> => {
        try {
          return { status: "accepted", result: await this.processOne(adapter, rawEvent, req) };
        } catch (err) {
          return { status: "rejected", error: errorMessage(err) };
        }
      }),
    );

    const acceptedCount = results.filter((r) => r.status === "accepted").length;
    return { totalCount: results.length, acceptedCount, rejectedCount: results.length - acceptedCount, results };
  }

  private async processOne(adapter: IAgentAdapter, rawEvent: unknown, req: Request): Promise<TelemetryPipelineResult> {
    const canonicalEvent = adapter.translateTelemetry(rawEvent);

    // Defense in depth: never trust the raw payload's own claimed
    // agent_id/tenant_id as authorization — it must match the identity
    // HmacValidationMiddleware already authenticated via the shared
    // secret, or this is either a misconfigured adapter or a forged event.
    if (canonicalEvent.agent_id !== req.telemetryAgentId || canonicalEvent.tenant_id !== req.tenantId) {
      throw new ForbiddenException("Telemetry event does not match the authenticated agent.");
    }

    // A telemetry request arrives via HmacValidationMiddleware, which
    // deliberately runs OUTSIDE TenantContextMiddleware (no user JWT to
    // derive tenant context from) — so app.current_tenant is never set by
    // the time a request reaches here. Every downstream write the pipeline
    // makes (dead-letter, metrics, and WO-043's PHI audit trail/quarantine)
    // targets an RLS-protected, tenant-scoped table, so this establishes
    // that context itself, the same BEGIN/set_config/COMMIT shape
    // TenantContextMiddleware uses for a normal authenticated request.
    // Found via testing: without this, any of those downstream writes
    // fails outright with "new row violates row-level security policy"
    // rather than silently succeeding or silently doing nothing.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [canonicalEvent.tenant_id]);
      const result = await this.pipeline.process(client, canonicalEvent);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}
