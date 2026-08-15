import { test } from "node:test";
import assert from "node:assert/strict";
import { CreditLedgerService } from "../../src/credits/credit-ledger.service";

class FakeRepository {
  public created: unknown[] = [];
  public balances = new Map<string, { tenantId: string; teamId: string | null; netBalance: number; transactionCount: number; lastTransactionAt: Date | null }>();
  public history: unknown[] = [];
  public refreshed = 0;
  public runningBalance = 0;

  async recordTransaction(_client: unknown, tenantId: string, input: Record<string, unknown>) {
    const delta = input.entryType === "credit" ? (input.amount as number) : -(input.amount as number);
    this.runningBalance += delta;
    const transaction = {
      id: `txn-${this.created.length + 1}`,
      tenantId,
      teamId: input.teamId,
      agentId: input.agentId,
      creditsDebit: input.entryType === "debit" ? input.amount : 0,
      creditsCredit: input.entryType === "credit" ? input.amount : 0,
      runningBalance: this.runningBalance,
      actionType: input.actionType,
      description: input.description,
      actorId: input.actorId,
      occurredAt: new Date(),
      createdAt: new Date(),
    };
    this.created.push(transaction);
    return transaction;
  }

  async getBalance(_client: unknown, tenantId: string, teamId: string | null) {
    return this.balances.get(`${tenantId}:${teamId}`) ?? null;
  }

  async getTransactionHistory() {
    return { rows: this.history, total: this.history.length };
  }

  async refreshBalances() {
    this.refreshed++;
  }
}

class FakeAuditService {
  public events: unknown[] = [];
  async recordEvent(event: unknown) {
    this.events.push(event);
  }
}

function buildRig() {
  const repository = new FakeRepository();
  const auditService = new FakeAuditService();
  const service = new CreditLedgerService(repository as any, auditService as any);
  return { repository, auditService, service };
}

test("recordTransaction: a valid credit is recorded and audited", async () => {
  const { repository, auditService, service } = buildRig();
  const transaction = await service.recordTransaction(undefined, "tenant-a", { teamId: "team-1", agentId: null, entryType: "credit", amount: 100, actionType: "topup", description: "initial grant", actorId: "user-1" });

  assert.equal(transaction.creditsCredit, 100);
  assert.equal(transaction.creditsDebit, 0);
  assert.equal(transaction.runningBalance, 100);
  assert.equal(repository.created.length, 1);
  assert.equal(auditService.events.length, 1);
  assert.equal((auditService.events[0] as any).action, "credit.credit_recorded");
});

test("recordTransaction: a valid debit is recorded and audited", async () => {
  const { repository, service } = buildRig();
  repository.runningBalance = 100;
  const transaction = await service.recordTransaction(undefined, "tenant-a", { teamId: null, agentId: "agent-1", entryType: "debit", amount: 30, actionType: "usage", description: "agent execution", actorId: null });

  assert.equal(transaction.creditsDebit, 30);
  assert.equal(transaction.creditsCredit, 0);
  assert.equal(transaction.runningBalance, 70);
});

test("recordTransaction rejects a zero-amount transaction", async () => {
  const { service } = buildRig();
  await assert.rejects(() => service.recordTransaction(undefined, "tenant-a", { teamId: null, agentId: null, entryType: "credit", amount: 0, actionType: "usage", description: null, actorId: null }));
});

test("recordTransaction rejects a negative-amount transaction (a 'negative debit' attempt)", async () => {
  const { service } = buildRig();
  await assert.rejects(() => service.recordTransaction(undefined, "tenant-a", { teamId: null, agentId: null, entryType: "debit", amount: -50, actionType: "usage", description: null, actorId: null }));
});

test("recordTransaction rejects a non-finite amount", async () => {
  const { service } = buildRig();
  await assert.rejects(() => service.recordTransaction(undefined, "tenant-a", { teamId: null, agentId: null, entryType: "credit", amount: NaN, actionType: "usage", description: null, actorId: null }));
});

test("getBalance: a zero-balance tenant with no transactions returns a real zero, not an error", async () => {
  const { service } = buildRig();
  const balance = await service.getBalance(undefined, "tenant-with-no-history", null);
  assert.equal(balance.netBalance, 0);
  assert.equal(balance.transactionCount, 0);
  assert.equal(balance.lastTransactionAt, null);
});

test("getBalance: returns the repository's real aggregated balance when one exists", async () => {
  const { repository, service } = buildRig();
  repository.balances.set("tenant-a:team-1", { tenantId: "tenant-a", teamId: "team-1", netBalance: 250, transactionCount: 12, lastTransactionAt: new Date("2026-08-15T00:00:00Z") });
  const balance = await service.getBalance(undefined, "tenant-a", "team-1");
  assert.equal(balance.netBalance, 250);
  assert.equal(balance.transactionCount, 12);
});

test("getTransactionHistory delegates straight through with the given filters", async () => {
  const { repository, service } = buildRig();
  repository.history = [{ id: "txn-1" }, { id: "txn-2" }];
  const result = await service.getTransactionHistory(undefined, "tenant-a", { limit: 50, offset: 0 });
  assert.equal(result.total, 2);
});

test("refreshBalances delegates to the repository", async () => {
  const { repository, service } = buildRig();
  await service.refreshBalances();
  assert.equal(repository.refreshed, 1);
});
