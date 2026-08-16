import type { CreditConsumptionEvent } from "../credit-consumption-kafka-producer.service";

export interface DlqEntry {
  event: CreditConsumptionEvent;
  error: string;
  retryCount: number;
  failedAt: string;
}

export interface BatchResult {
  processed: number;
  deduplicated: number;
  /** Events skipped because they don't represent unreconciled consumption at all (e.g. a "denied" decision, or a "ledger"-mode event that already recorded a real debit at decision time — see CreditReconciliationService's own doc comment). */
  skipped: number;
  failed: DlqEntry[];
  /** Distinct (tenantId, teamId) pairs touched by this batch — what the post-batch cache re-warm step needs to know. */
  affectedBalanceKeys: Array<{ tenantId: string; teamId: string | null }>;
}
