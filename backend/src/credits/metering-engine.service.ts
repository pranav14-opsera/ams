import { Injectable, Logger } from "@nestjs/common";
import { CreditCacheCircuitBreakerService } from "./credit-cache-circuit-breaker.service";
import { CreditConsumptionKafkaProducerService } from "./credit-consumption-kafka-producer.service";
import { CreditLedgerService } from "./credit-ledger.service";
import { CreditRateMappingService } from "./credit-rate-mapping.service";
import { HARD_CAP_BUFFER_FRACTION, type EnforcementMode, type MeteringDecision, type MeteringRequest, type MeteringResult } from "./metering-engine.types";

/**
 * AC: the real-time enforcement layer — sub-500ms allow/deny decisions
 * via a Redis cache, falling through to a synchronous Postgres ledger
 * check only when the operation would land within 5% of a team's hard
 * cap (or when Redis itself is unavailable — see
 * CreditCacheCircuitBreakerService's "never fail open" posture).
 *
 * Decision paths (this WO's own AC test list): cache hit allow, cache
 * hit deny, fallthrough-to-ledger allow, fallthrough-to-ledger deny,
 * cache miss (warms the cache from the real ledger balance, then
 * re-enters the same decision tree with a fresh value).
 */
@Injectable()
export class MeteringEngineService {
  private readonly logger = new Logger(MeteringEngineService.name);

  constructor(
    private readonly rateMappingService: CreditRateMappingService,
    private readonly cacheBreaker: CreditCacheCircuitBreakerService,
    private readonly ledgerService: CreditLedgerService,
    private readonly kafkaProducer: CreditConsumptionKafkaProducerService,
  ) {}

  async checkAndConsume(request: MeteringRequest): Promise<MeteringResult> {
    const start = Date.now();
    const units = request.units ?? 1;

    const rate = await this.rateMappingService.getRate(undefined, request.tenantId, request.actionType);
    if (rate === null) {
      return this.finish(request, start, "denied", "cache", 0, null, "no credit rate configured for this action_type");
    }

    const cost = Math.round(rate * units);
    if (cost <= 0) {
      return this.finish(request, start, "allowed", "cache", 0, null);
    }

    const hardCap = request.teamId ? await this.rateMappingService.getHardCap(undefined, request.tenantId, request.teamId) : null;

    let peekedBalance = await this.cacheBreaker.getBalance(request.tenantId, request.teamId);
    if (peekedBalance === "circuit_open") {
      return this.fallthroughToLedger(request, start, cost);
    }
    if (peekedBalance === null) {
      const ledgerBalance = await this.ledgerService.getBalance(undefined, request.tenantId, request.teamId);
      peekedBalance = ledgerBalance.netBalance;
      await this.cacheBreaker.warmCache(request.tenantId, request.teamId, peekedBalance);
    }

    const projected = peekedBalance - cost;
    const nearHardCap = hardCap !== null && projected <= hardCap * HARD_CAP_BUFFER_FRACTION;
    if (nearHardCap) {
      return this.fallthroughToLedger(request, start, cost);
    }

    if (projected < 0) {
      return this.finish(request, start, "denied", "cache", cost, peekedBalance, "insufficient cached balance");
    }

    const result = await this.cacheBreaker.checkAndDecrement(request.tenantId, request.teamId, cost);
    if (result.outcome === "circuit_open" || result.outcome === "cache_miss") {
      // Rare TOCTOU (e.g. the key expired between the peek above and this atomic call) — fall through to the authoritative ledger rather than guessing.
      return this.fallthroughToLedger(request, start, cost);
    }
    if (result.outcome === "denied") {
      return this.finish(request, start, "denied", "cache", cost, result.balance, "insufficient balance at atomic decrement");
    }
    return this.finish(request, start, "allowed", "cache", cost, result.balance);
  }

  private async fallthroughToLedger(request: MeteringRequest, start: number, cost: number): Promise<MeteringResult> {
    const balance = await this.ledgerService.getBalance(undefined, request.tenantId, request.teamId);
    if (balance.netBalance < cost) {
      return this.finish(request, start, "denied", "ledger", cost, balance.netBalance, "insufficient ledger balance");
    }

    const transaction = await this.ledgerService.recordTransaction(undefined, request.tenantId, {
      teamId: request.teamId,
      agentId: request.agentId,
      entryType: "debit",
      amount: cost,
      actionType: request.actionType,
      description: `metering: ${request.actionType}`,
      actorId: null,
    });
    await this.cacheBreaker.warmCache(request.tenantId, request.teamId, transaction.runningBalance);
    return this.finish(request, start, "allowed", "ledger", cost, transaction.runningBalance);
  }

  private finish(
    request: MeteringRequest,
    start: number,
    decision: MeteringDecision,
    enforcementMode: EnforcementMode,
    creditsConsumed: number,
    balanceAfter: number | null,
    reason?: string,
  ): MeteringResult {
    const latencyMs = Date.now() - start;
    const result: MeteringResult = { decision, enforcementMode, creditsConsumed, balanceAfter, latencyMs, ...(reason ? { reason } : {}) };

    // AC: "structured JSON logging for every metering decision including latency_ms, enforcement_mode, decision, tenant_id, team_id, and agent_id".
    this.logger.log(
      JSON.stringify({
        event: "credit_metering_decision",
        tenant_id: request.tenantId,
        team_id: request.teamId,
        agent_id: request.agentId,
        action_type: request.actionType,
        decision,
        enforcement_mode: enforcementMode,
        credits_consumed: creditsConsumed,
        balance_after: balanceAfter,
        latency_ms: latencyMs,
        reason: reason ?? null,
      }),
    );

    this.kafkaProducer
      .publish({
        tenantId: request.tenantId,
        teamId: request.teamId,
        agentId: request.agentId,
        actionType: request.actionType,
        creditsConsumed,
        enforcementMode,
        decision,
        occurredAt: new Date().toISOString(),
      })
      .catch((err) => this.logger.warn(`credit consumption event publish failed (non-blocking): ${err instanceof Error ? err.message : err}`));

    return result;
  }
}
