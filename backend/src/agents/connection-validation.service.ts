import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../common/database/database.module";
import { AgentsRepository } from "./agents.repository";
import type { AgentFramework } from "./dto/create-agent.dto";
import { LifecycleService } from "./lifecycle.service";

export type ConnectionValidationStatus = "pending" | "success" | "failed";

export interface ConnectionValidationResult {
  status: ConnectionValidationStatus;
  message: string | null;
  completedAt: string | null;
}

const VALIDATION_TIMEOUT_MS = 15_000; // Well within the AC's own 60-second budget — leaves headroom for the wizard's own poll interval to observe the outcome before its 60s client-side timeout fires.

/**
 * Resolves the URL this WO's own AC 4/5 framework schemas designate as
 * "the thing that proves this specific agent's credentials/endpoint are
 * reachable" — LangChain's `callbackUrl` (telemetry callback) and generic
 * REST's `baseUrl` + `healthCheckEndpoint`. Framework-specific by design
 * (same pluggable-schema spirit as the frontend's own JSON-schema-driven
 * form renderer): a Phase 2 framework (CrewAI/AutoGen) simply isn't
 * resolvable yet, which is why `validate` below treats an unresolvable
 * URL as "cannot validate", not a hard failure.
 */
function resolveValidationUrl(framework: AgentFramework, connectionConfig: Record<string, unknown>): string | null {
  if (framework === "langchain") {
    const url = connectionConfig.callbackUrl;
    return typeof url === "string" && url.length > 0 ? url : null;
  }
  if (framework === "generic_rest") {
    const base = connectionConfig.baseUrl;
    const healthPath = connectionConfig.healthCheckEndpoint;
    if (typeof base !== "string" || base.length === 0) return null;
    if (typeof healthPath !== "string" || healthPath.length === 0) return null;
    try {
      return new URL(healthPath, base).toString();
    } catch {
      return null;
    }
  }
  return null; // crewai/autogen: Phase 2, no schema-defined validation URL yet.
}

/**
 * Minimal SSRF guard (OWASP A10) on a URL a tenant admin supplies at
 * registration time: only plain http(s) is ever fetched, and the
 * loopback/link-local ranges a server-side fetch should never be tricked
 * into reaching are rejected outright — loopback (this server's own
 * admin surfaces) and link-local (169.254.0.0/16, which covers the
 * AWS/GCP/Azure instance-metadata endpoint at 169.254.169.254) are the
 * two ranges an SSRF payload actually targets. Deliberately does NOT
 * block the broader RFC1918 private ranges (10/8, 172.16/12, 192.168/16):
 * a real deployment topology for this platform (agents running inside a
 * tenant's own VPC/on-prem network, reachable only from there) makes a
 * private-network agent endpoint entirely legitimate, not a red flag —
 * blocking it outright would make the wizard falsely reject a completely
 * normal registration. This is a best-effort hostname-literal check (no
 * DNS-rebinding protection — resolving the hostname and re-checking the
 * resolved IP is a further hardening step this WO doesn't attempt), same
 * tradeoff class as this codebase's other webhook-style URL fields (e.g.
 * telemetry callback URLs elsewhere) which have no dedicated
 * SSRF-hardening pass of their own either.
 */
function isBlockedHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower === "0.0.0.0" || lower.endsWith(".local")) return true;
  const ipv4 = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local / cloud metadata endpoint
  }
  return false;
}

/**
 * WO-080 Step 4 (Validate & Confirm): the actual server-side "reach this
 * agent's own endpoint" check the wizard's polling loop is watching for.
 * Kicked off fire-and-forget (never awaited by AgentsController.create —
 * see that best-effort `.catch()` call site) immediately after agent
 * creation, so POST /api/v1/agents itself stays within this WO's own "within
 * 5 seconds" AC regardless of how long the target endpoint takes to answer.
 *
 * Deliberately does NOT introduce a new lifecycle status: the existing
 * state machine (lifecycle-state-machine.ts) only allows
 * connecting->active or connecting->decommissioned — there is no
 * "failed" lifecycle state, and adding one is a cross-cutting change
 * (DB CHECK constraint, every existing lifecycle-status consumer, this
 * session's own WO-079 registry page) well outside this WO's scope. A
 * validation failure/timeout is instead recorded on the agent's own
 * `metadata` column (already a flexible JSONB field returned by every
 * existing agent read) as `metadata.connectionValidation`, surfaced by
 * agent.mapper.ts's own `connectionValidation` field — the agent itself
 * simply stays in `connecting` until an administrator acts on it (matches
 * the state machine's actual shape rather than inventing a new one).
 *
 * Deliberately owns its own DB connection rather than accepting the
 * caller's `req.tenantDbClient`: this runs fire-and-forget, well after
 * AgentsController.create's response has already been sent, and
 * TenantContextMiddleware commits + releases that request-scoped client
 * back to the pool the moment the response finishes (`res.on("finish")`)
 * — reusing it here would either query an already-released client or,
 * worse, run on a connection some other, unrelated request has since
 * checked out. `agents` has row-level security enabled (migration 006,
 * `enable_tenant_isolation('agents')`), so a bare pool query (no
 * `app.current_tenant` set) is the same silent-zero-rows/invalid-uuid
 * bug class TeamMembershipRepository's own docstring calls out — this
 * opens and tenant-scopes ONE fresh connection for its own lifetime,
 * same pattern as CalibrationService.withTenantScope.
 */
@Injectable()
export class ConnectionValidationService {
  private readonly logger = new Logger(ConnectionValidationService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly repository: AgentsRepository,
    private readonly lifecycleService: LifecycleService,
  ) {}

  private async withTenantScope<T>(tenantId: string, fn: (executor: PoolClient) => Promise<T>): Promise<T> {
    const scoped = await this.pool.connect();
    try {
      await scoped.query("SELECT set_config('app.current_tenant', $1, false)", [tenantId]);
      return await fn(scoped);
    } finally {
      scoped.release();
    }
  }

  async validate(tenantId: string, actorId: string | null, agentId: string, framework: AgentFramework, connectionConfig: Record<string, unknown>): Promise<void> {
    const url = resolveValidationUrl(framework, connectionConfig);
    if (!url) {
      // Nothing schema-defined to reach (Phase 2 framework, or a caller
      // that omitted the field despite DTO validation somehow passing) —
      // recorded as a failure so the wizard doesn't poll forever, not
      // silently left "pending".
      await this.recordOutcome(tenantId, agentId, {
        status: "failed",
        message: `No reachable endpoint could be resolved from the ${framework} connection configuration.`,
        completedAt: new Date().toISOString(),
      });
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      await this.recordOutcome(tenantId, agentId, {
        status: "failed",
        message: "The configured endpoint is not a valid URL.",
        completedAt: new Date().toISOString(),
      });
      return;
    }

    if (!["http:", "https:"].includes(parsed.protocol) || isBlockedHost(parsed.hostname)) {
      await this.recordOutcome(tenantId, agentId, {
        status: "failed",
        message: "Could not reach endpoint — the configured host is not permitted for connection validation.",
        completedAt: new Date().toISOString(),
      });
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);
    try {
      const response = await fetch(parsed.toString(), { method: "GET", signal: controller.signal });
      if (response.ok) {
        await this.recordOutcome(tenantId, agentId, {
          status: "success",
          message: "Connection validated successfully.",
          completedAt: new Date().toISOString(),
        });
        await this.withTenantScope(tenantId, (executor) => this.lifecycleService.transition(executor, tenantId, actorId, agentId, "active", undefined));
      } else {
        await this.recordOutcome(tenantId, agentId, {
          status: "failed",
          message: `Could not reach endpoint — it responded with HTTP ${response.status}.`,
          completedAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "AbortError";
      await this.recordOutcome(tenantId, agentId, {
        status: "failed",
        message: timedOut
          ? "Connection validation timed out — verify the endpoint is reachable from the internet."
          : `Could not reach endpoint — verify the URL is accessible from the internet. (${err instanceof Error ? err.message : "unknown error"})`,
        completedAt: new Date().toISOString(),
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async recordOutcome(tenantId: string, agentId: string, result: ConnectionValidationResult): Promise<void> {
    try {
      await this.withTenantScope(tenantId, async (executor) => {
        const current = await this.repository.findOne(executor, tenantId, agentId);
        if (!current) return; // Agent was decommissioned/removed while validation was in flight.
        await this.repository.update(executor, tenantId, agentId, { metadata: { ...current.metadata, connectionValidation: result } });
      });
    } catch (err) {
      this.logger.warn(`failed to record connection validation outcome for agent ${agentId}: ${err instanceof Error ? err.message : err}`);
    }
  }
}
