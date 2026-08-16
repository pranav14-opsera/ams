import { Injectable, Logger } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { AlertDeliveryService } from "../../alerts/alert-delivery.service";
import { AlertEventRepository } from "../../alerts/alert-event.repository";
import { CreditCacheCircuitBreakerService } from "../credit-cache-circuit-breaker.service";
import type { CreditConsumptionEvent } from "../credit-consumption-kafka-producer.service";
import { CreditLedgerService } from "../credit-ledger.service";
import { CreditConsumptionDlqProducerService } from "./credit-consumption-dlq-producer.service";
import { CreditProcessedEventRepository } from "./credit-processed-event.repository";
import type { BatchResult, DlqEntry } from "./credit-reconciliation.types";

const DLQ_METRIC_NAME = "credit_reconciliation_dlq";

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
    /** Optional — existing/test call sites that don't pass these simply never raise a real alert on DLQ routing (same zero-blast-radius optional-DI convention used throughout this codebase). */
    private readonly alertEventRepository?: AlertEventRepository,
    private readonly alertDeliveryService?: AlertDeliveryService,
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
        await this.raiseDlqAlert(event, entry);
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

  /**
   * AC: "an alert is emitted" on DLQ routing — reuses WO-060's own shared
   * alert-delivery pipeline rather than inventing a separate
   * notification path. Best-effort: a failure to raise the ALERT about a
   * failure must never itself throw and mask the original DLQ routing
   * outcome.
   *
   * `alert_events.agent_id` is a NOT NULL FK (migration 046) — every
   * existing alert in this codebase is agent-scoped. A DLQ'd consumption
   * event is a TENANT-level failure that may have no agent at all (e.g.
   * a team-level top-up event) — there's no valid agents.id to attach
   * the alert to in that case, so it's skipped with an explicit warning
   * log rather than silently fabricating a fake agent reference. This is
   * an honest architectural gap (this WO's own alert_events schema
   * predates a genuinely agent-less alert concept), not a bug.
   */
  private async raiseDlqAlert(event: CreditConsumptionEvent, entry: DlqEntry): Promise<void> {
    if (!this.alertEventRepository || !this.alertDeliveryService) return;
    if (!event.agentId) {
      this.logger.warn(`DLQ event ${entry.event.eventId} has no agent_id — skipping alert_events emission (that table requires a real agent) for this tenant-level failure`);
      return;
    }
    try {
      const alertEvent = await this.alertEventRepository.create(undefined, event.tenantId, event.agentId, {
        metricName: DLQ_METRIC_NAME,
        thresholdValue: 0,
        actualValue: 1,
        severity: "warning",
        breachTimestamp: new Date(),
        detectionMethod: "threshold",
      });
      await this.alertDeliveryService.deliver(alertEvent);
    } catch (err) {
      this.logger.warn(`failed to raise a DLQ alert for event ${entry.event.eventId} (the event was still correctly routed to the DLQ itself): ${err instanceof Error ? err.message : err}`);
    }
  }
}
