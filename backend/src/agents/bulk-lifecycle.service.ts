import { BadRequestException, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import type { BulkLifecycleDto } from "./dto/bulk-lifecycle.dto";
import { AgentsRepository } from "./agents.repository";
import { JUSTIFICATION_REQUIRED_STATUSES } from "./lifecycle-state-machine";
import { LifecycleService } from "./lifecycle.service";

export const MAX_BULK_BATCH_SIZE = 100;
const BULK_CONCURRENCY_LIMIT = 10;
export const BULK_LIFECYCLE_TIMEOUT_MS = 30_000;

export interface BulkLifecycleAgentResult {
  agentId: string;
  status: "success" | "failed";
  previousStatus: string | null;
  newStatus: string | null;
  warning: string | null;
  error: string | null;
}

export interface BulkLifecycleResult {
  totalCount: number;
  successCount: number;
  failureCount: number;
  results: BulkLifecycleAgentResult[];
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

@Injectable()
export class BulkLifecycleService {
  constructor(
    private readonly agentsRepository: AgentsRepository,
    private readonly lifecycleService: LifecycleService,
  ) {}

  async execute(
    client: Pool | PoolClient | undefined,
    tenantId: string,
    actorId: string | null,
    dto: BulkLifecycleDto,
    timeoutMs: number = BULK_LIFECYCLE_TIMEOUT_MS,
  ): Promise<BulkLifecycleResult> {
    if (JUSTIFICATION_REQUIRED_STATUSES.includes(dto.targetStatus) && !dto.justification?.trim()) {
      throw new BadRequestException(`A justification is required to transition agents to "${dto.targetStatus}".`);
    }

    const agentIds = await this.resolveAgentIds(client, tenantId, dto);
    if (agentIds.length === 0) {
      return { totalCount: 0, successCount: 0, failureCount: 0, results: [] };
    }

    // `.fill(undefined)` matters: a bare `new Array(n)` is sparse (every
    // index is a hole, not a real `undefined` element), and `.map()` skips
    // holes entirely rather than invoking its callback on them — the
    // timeout fallback below would silently vanish those entries instead
    // of filling them in. Found via testing the timeout path directly.
    const results: Array<BulkLifecycleAgentResult | undefined> = new Array(agentIds.length).fill(undefined);
    let nextIndex = 0;

    // Each per-agent transition deliberately does NOT reuse the caller's
    // single request-scoped `client` — node-postgres queues every query
    // issued against one physical connection, so funneling up to 100
    // transitions through it would serialize them and make the 30-second
    // budget for 100 agents unreachable. Passing `undefined` lets each
    // call check out its own connection from the pool, giving genuine
    // concurrency (bounded by BULK_CONCURRENCY_LIMIT).
    const runNext = async (): Promise<void> => {
      for (;;) {
        const i = nextIndex++;
        if (i >= agentIds.length) return;
        const agentId = agentIds[i];
        try {
          const transition = await this.lifecycleService.transition(undefined, tenantId, actorId, agentId, dto.targetStatus, dto.justification);
          results[i] = {
            agentId,
            status: "success",
            previousStatus: transition.previousStatus,
            newStatus: transition.agent.lifecycleStatus,
            warning: transition.warning,
            error: null,
          };
        } catch (err) {
          results[i] = {
            agentId,
            status: "failed",
            previousStatus: null,
            newStatus: null,
            warning: null,
            error: errorMessage(err),
          };
        }
      }
    };

    const workerCount = Math.min(BULK_CONCURRENCY_LIMIT, agentIds.length);
    const allSettled = Promise.all(Array.from({ length: workerCount }, () => runNext()));
    const timedOut = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs));
    await Promise.race([allSettled, timedOut]);

    // Anything still `undefined` here means its worker never got to it
    // before the timeout — reported as its own failure category rather
    // than silently dropped from the response.
    const finalResults = results.map(
      (result, i): BulkLifecycleAgentResult =>
        result ?? {
          agentId: agentIds[i],
          status: "failed",
          previousStatus: null,
          newStatus: null,
          warning: null,
          error: `Bulk operation timed out after ${timeoutMs}ms before this agent's transition could run.`,
        },
    );

    const successCount = finalResults.filter((r) => r.status === "success").length;
    return {
      totalCount: finalResults.length,
      successCount,
      failureCount: finalResults.length - successCount,
      results: finalResults,
    };
  }

  private async resolveAgentIds(client: Pool | PoolClient | undefined, tenantId: string, dto: BulkLifecycleDto): Promise<string[]> {
    // `dto.agentIds !== undefined` (not `.length > 0`) is deliberate: an
    // explicitly-empty array is a valid, if vacuous, request — it must
    // resolve to zero agents, not fall through to "neither was provided".
    if (dto.agentIds !== undefined) {
      const deduped = Array.from(new Set(dto.agentIds));
      // Defense in depth: the DTO's own @ArrayMaxSize(100) already rejects
      // this at the HTTP layer, but BulkLifecycleService is also called
      // directly in unit tests bypassing class-validator, so the batch-size
      // rule must hold at this layer too.
      if (deduped.length > MAX_BULK_BATCH_SIZE) {
        throw new BadRequestException(`A maximum of ${MAX_BULK_BATCH_SIZE} agent_ids may be provided per bulk request (received ${deduped.length}).`);
      }
      return deduped;
    }

    if (dto.filter) {
      const { rows, total } = await this.agentsRepository.findAll(client, tenantId, {
        teamId: dto.filter.teamId,
        framework: dto.filter.framework,
        lifecycleStatus: dto.filter.currentStatus,
        limit: MAX_BULK_BATCH_SIZE + 1,
        offset: 0,
      });
      if (total > MAX_BULK_BATCH_SIZE) {
        throw new BadRequestException(
          `The filter matched ${total} agents, which exceeds the maximum bulk batch size of ${MAX_BULK_BATCH_SIZE}. Narrow the filter or use explicit agent_ids.`,
        );
      }
      return rows.map((row) => row.id);
    }

    throw new BadRequestException("Either agent_ids or filter criteria must be provided.");
  }
}
