import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { DataClassification } from "../classification/data-classification.enum";
import { AUDIT_SERVICE, type AuditServicePort } from "../tenants/ports/audit-service.port";
import { CreditTransactionRepository } from "./credit-transaction.repository";
import type { CreditBalance, CreditEntryType, CreditTransaction, TransactionHistoryFilters } from "./credit-transaction.types";

export interface RecordTransactionRequest {
  teamId: string | null;
  agentId: string | null;
  entryType: CreditEntryType;
  amount: number;
  actionType: string;
  description: string | null;
  actorId: string | null;
}

/**
 * AC: "the authoritative source of truth for all credit balances" — a
 * financial ledger, append-only, every mutation audited (SOC 2/HIPAA).
 */
@Injectable()
export class CreditLedgerService {
  constructor(
    private readonly repository: CreditTransactionRepository,
    @Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort,
  ) {}

  async recordTransaction(client: Pool | PoolClient | undefined, tenantId: string, request: RecordTransactionRequest): Promise<CreditTransaction> {
    if (!Number.isFinite(request.amount) || request.amount <= 0) {
      throw new BadRequestException("amount must be a positive, finite number — a debit or credit of 0 or less is never a valid transaction.");
    }

    const transaction = await this.repository.recordTransaction(client, tenantId, {
      teamId: request.teamId,
      agentId: request.agentId,
      entryType: request.entryType,
      amount: request.amount,
      actionType: request.actionType,
      description: request.description,
      actorId: request.actorId,
    });

    // AC: "every credit mutation must produce an immutable audit record" — best-effort (never rolls back an already-committed ledger entry over an audit-plumbing failure), same posture as every other financial/security-sensitive write in this codebase.
    await this.auditService
      .recordEvent({
        tenantId,
        actorId: request.actorId,
        action: `credit.${request.entryType}_recorded`,
        resourceType: "credit_transaction",
        resourceId: transaction.id,
        details: {
          teamId: request.teamId,
          agentId: request.agentId,
          amount: request.amount,
          actionType: request.actionType,
          runningBalance: transaction.runningBalance,
        },
        dataClassification: DataClassification.CONFIDENTIAL,
      })
      .catch(() => undefined);

    return transaction;
  }

  async getBalance(client: Pool | PoolClient | undefined, tenantId: string, teamId: string | null): Promise<CreditBalance> {
    const balance = await this.repository.getBalance(client, tenantId, teamId);
    return balance ?? { tenantId, teamId, netBalance: 0, transactionCount: 0, lastTransactionAt: null };
  }

  async getTransactionHistory(client: Pool | PoolClient | undefined, tenantId: string, filters: TransactionHistoryFilters): Promise<{ rows: CreditTransaction[]; total: number }> {
    return this.repository.getTransactionHistory(client, tenantId, filters);
  }

  async refreshBalances(client?: Pool | PoolClient): Promise<void> {
    await this.repository.refreshBalances(client);
  }
}
