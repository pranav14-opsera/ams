import { Injectable, Logger } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { CreditCacheCircuitBreakerService } from "../credit-cache-circuit-breaker.service";
import type { CreditConsumptionEvent } from "../credit-consumption-kafka-producer.service";
import { CreditLedgerService } from "../credit-ledger.service";
import { CreditConsumptionDlqProducerService } from "./credit-consumption-dlq-producer.service";
import { CreditProcessedEventRepository } from "./credit-processed-event.repository";
import type { BatchResult, DlqEntry } from "./credit-reconciliation.types";

/**
 * AC: bridges WO-066's Redis-fast-path metering with WO-065's
 * authoritative ledger. Only "cache"-enforcement-mode, "allowed",
 * non-zero-cost events represent consumption that ISN'T already in the
 * ledger — a "ledger"-mode event's debit was already recorded
 * synchronously at decision time (MeteringEngineService.fallthroughToLedger),
 * and re-recording it here would double-debit the tenant. "denied"
 * events consumed nothing at all. Both are correctly skipped, not
 * treated as failures.
 */
@Injectable()
export class CreditReconciliationService {
  private readonly logger = new Logger(CreditReconciliationService.name);
  private lastSuccessfulBatchAt: Date | null = null;

  constructor(
    private readonly processedEventRepository: CreditProcessedEventRepository,
    private readonly ledgerService: CreditLedgerService,
    private readonly cacheBreaker: CreditCacheCircuitBreakerService,
    private readonly dlqProducer: CreditConsumptionDlqProducerService,
  ) {}

  getLastSuccessfulBatchAt(): Date | null {
    return this.lastSuccessfulBatchAt;
  }

  async processBatch(client: Pool | PoolClient | undefined, events: CreditConsumptionEvent[]): Promise<BatchResult> {
    let processedCount = 0;
    let deduplicated = 0;
    let skipped = 0;
    const failed: DlqEntry[] = [];
    const affectedKeys = new Map<string, { tenantId: string; teamId: string | null }>();

    for (const event of events) {
      try {
        if (event.decision !== "allowed" || event.enforcementMode !== "cache" || event.creditsConsumed <= 0) {
          skipped++;
          continue;
        }

        const already = await this.processedEventRepository.isProcessed(client, event.eventId);
        if (already) {
          deduplicated++;
          continue;
        }

        await this.ledgerService.recordTransaction(client, event.tenantId, {
          teamId: event.teamId,
          agentId: event.agentId,
          entryType: "debit",
          amount: event.creditsConsumed,
          actionType: event.actionType,
          description: `reconciliation: ${event.actionType}`,
          actorId: null,
        });
        await this.processedEventRepository.markProcessed(client, event.eventId, event.tenantId);
        processedCount++;
        affectedKeys.set(`${event.tenantId}:${event.teamId ?? ""}`, { tenantId: event.tenantId, teamId: event.teamId });
      } catch (err) {
        const entry: DlqEntry = { event, error: err instanceof Error ? err.message : String(err), retryCount: 0, failedAt: new Date().toISOString() };
        failed.push(entry);
        await this.dlqProducer.publish(entry).catch((dlqErr) => this.logger.error(`failed to publish DLQ entry for event ${event.eventId} (event itself already dropped from this batch): ${dlqErr instanceof Error ? dlqErr.message : dlqErr}`));
      }
    }

    if (processedCount > 0) {
      await this.ledgerService.refreshBalances(client);
      for (const key of affectedKeys.values()) {
        try {
          const balance = await this.ledgerService.getBalance(client, key.tenantId, key.teamId);
          await this.cacheBreaker.warmCache(key.tenantId, key.teamId, balance.netBalance);
        } catch (err) {
          this.logger.warn(`cache re-warm failed for ${key.tenantId}/${key.teamId} after reconciliation (next metering check will simply see a cache miss and re-warm itself): ${err instanceof Error ? err.message : err}`);
        }
      }
      this.lastSuccessfulBatchAt = new Date();
    }

    return { processed: processedCount, deduplicated, skipped, failed, affectedBalanceKeys: [...affectedKeys.values()] };
  }
}
