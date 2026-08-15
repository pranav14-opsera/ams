export const CREDIT_ENTRY_TYPES = ["debit", "credit"] as const;
export type CreditEntryType = (typeof CREDIT_ENTRY_TYPES)[number];

export interface CreditTransaction {
  id: string;
  tenantId: string;
  teamId: string | null;
  agentId: string | null;
  creditsDebit: number;
  creditsCredit: number;
  runningBalance: number;
  actionType: string;
  description: string | null;
  actorId: string | null;
  occurredAt: Date;
  createdAt: Date;
}

export interface CreditBalance {
  tenantId: string;
  teamId: string | null;
  netBalance: number;
  transactionCount: number;
  lastTransactionAt: Date | null;
}

export interface RecordTransactionInput {
  teamId: string | null;
  agentId: string | null;
  entryType: CreditEntryType;
  amount: number;
  actionType: string;
  description: string | null;
  actorId: string | null;
  occurredAt?: Date;
}

export interface TransactionHistoryFilters {
  agentId?: string;
  teamId?: string;
  actionType?: string;
  startDate?: string;
  endDate?: string;
  limit: number;
  offset: number;
}
