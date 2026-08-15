import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { DataClassification } from "../classification/data-classification.enum";
import { AUDIT_SERVICE, type AuditServicePort } from "../tenants/ports/audit-service.port";
import { RedisPubSubService } from "../websocket-gateway/redis-pubsub.service";
import { AgentInFlightOperationsService } from "./agent-inflight-operations.service";
import { AgentStateTransitionsRepository } from "./agent-state-transitions.repository";
import { AgentResource, toAgentResource } from "./agent.mapper";
import { AgentsRepository } from "./agents.repository";
import type { AgentLifecycleStatus } from "./dto/list-agents-query.dto";
import { JUSTIFICATION_REQUIRED_STATUSES, isValidTransition, validTransitionsFrom } from "./lifecycle-state-machine";

// AC: "waits for their completion (up to a configurable timeout, default
// 30 seconds)".
export const DEFAULT_PAUSE_DRAIN_TIMEOUT_MS = 30_000;

export interface LifecycleTransitionResult {
  agent: AgentResource;
  warning: string | null;
}

@Injectable()
export class LifecycleService {
  constructor(
    private readonly repository: AgentsRepository,
    private readonly transitionsRepository: AgentStateTransitionsRepository,
    @Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort,
    private readonly inFlightOperations: AgentInFlightOperationsService,
    private readonly pubsub: RedisPubSubService,
  ) {}

  async transition(
    client: Pool | PoolClient | undefined,
    tenantId: string,
    actorId: string | null,
    agentId: string,
    targetStatus: AgentLifecycleStatus,
    justification: string | undefined,
    drainTimeoutMs: number = DEFAULT_PAUSE_DRAIN_TIMEOUT_MS,
  ): Promise<LifecycleTransitionResult> {
    const current = await this.repository.findOne(client, tenantId, agentId);
    if (!current) throw new NotFoundException(`No agent with id ${agentId}.`);
    const fromStatus = current.lifecycle_status;

    if (!isValidTransition(fromStatus, targetStatus)) {
      const valid = validTransitionsFrom(fromStatus);
      throw new ConflictException(
        `Cannot transition agent from "${fromStatus}" to "${targetStatus}". Valid transitions from "${fromStatus}": ${
          valid.length > 0 ? valid.join(", ") : "none"
        }.`,
      );
    }

    if (JUSTIFICATION_REQUIRED_STATUSES.includes(targetStatus) && !justification?.trim()) {
      throw new BadRequestException(`A justification is required to transition an agent to "${targetStatus}".`);
    }

    // AC: "when an agent is paused, the system tracks in-flight
    // operations and waits for their completion... before setting status
    // to Paused" — only the Active->Paused edge has anything to drain;
    // e.g. Connecting->Decommissioned never had in-flight work to begin with.
    let warningFlag = false;
    let incompleteOperationsCount: number | null = null;
    if (fromStatus === "active" && targetStatus === "paused") {
      const drain = await this.inFlightOperations.waitForDrain(agentId, drainTimeoutMs);
      if (!drain.drained) {
        warningFlag = true;
        incompleteOperationsCount = drain.remainingCount;
      }
    }

    const updated = await this.repository.compareAndSwapLifecycleStatus(client, tenantId, agentId, fromStatus, current.version, targetStatus);
    if (!updated) {
      throw new ConflictException("Agent was modified concurrently by another request. Please retry.");
    }

    await this.transitionsRepository.record(client, {
      tenantId,
      agentId,
      fromStatus,
      toStatus: targetStatus,
      justification: justification ?? null,
      actorId,
      warningFlag,
      incompleteOperationsCount,
    });

    await this.auditService.recordEvent({
      tenantId,
      actorId,
      action: "agent.lifecycle_transition",
      resourceType: "agent",
      resourceId: agentId,
      details: { fromStatus, toStatus: targetStatus, justification: justification ?? null, warningFlag, incompleteOperationsCount },
      dataClassification: DataClassification.RESTRICTED,
    });

    // Best-effort real-time push, reusing WO-030's established Redis
    // pub/sub event bus rather than standing up a second, otherwise-unused
    // message broker (e.g. Kafka, never installed anywhere in this
    // codebase) purely for this one lifecycle-event use case.
    this.pubsub.publish(tenantId, "agent-lifecycle", { agentId, fromStatus, toStatus: targetStatus, warningFlag }).catch(() => undefined);

    return {
      agent: toAgentResource(updated),
      warning: warningFlag ? `Agent paused with ${incompleteOperationsCount} in-flight operation(s) still running after the ${drainTimeoutMs}ms drain timeout.` : null,
    };
  }
}
