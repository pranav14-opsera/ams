import { Inject, Injectable } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../common/database/database.module";
import type { CreditBalance, CreditTransaction, RecordTransactionInput, TransactionHistoryFilters } from "./credit-transaction.types";

interface TransactionRow {
  id: string;
  tenant_id: string;
  team_id: string | null;
  agent_id: string | null;
  credits_debit: number;
  credits_credit: number;
  running_balance: number;
  action_type: string;
  description: string | null;
  actor_id: string | null;
  occurred_at: Date;
  created_at: Date;
}

interface BalanceRow {
  tenant_id: string;
  team_id: string | null;
  net_balance: string;
  transaction_count: string;
  last_transaction_at: Date | null;
}

function toDomain(row: TransactionRow): CreditTransaction {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    teamId: row.team_id,
    agentId: row.agent_id,
    creditsDebit: row.credits_debit,
    creditsCredit: row.credits_credit,
    runningBalance: row.running_balance,
    actionType: row.action_type,
    description: row.description,
    actorId: row.actor_id,
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

function toBalanceDomain(row: BalanceRow): CreditBalance {
  return {
    tenantId: row.tenant_id,
    teamId: row.team_id,
    netBalance: Number(row.net_balance),
    transactionCount: Number(row.transaction_count),
    lastTransactionAt: row.last_transaction_at,
  };
}

/**
 * `pg_advisory_xact_lock` (transaction-scoped, auto-released at COMMIT/
 * ROLLBACK) serializes concurrent writers for the SAME (tenant, team)
 * balance key — the running_balance computed here is read-then-add-then-
 * insert, which is only atomic under real concurrency with a lock; two
 * concurrent transactions for DIFFERENT (tenant, team) keys hash to
 * (almost certainly) different lock ids and never block each other.
 * `hashtextextended` with a fixed second argument (0) gives a stable
 * 64-bit hash of the composite key string, matching the single-bigint
 * overload of `pg_advisory_xact_lock`.
 */
const ADVISORY_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))";

@Injectable()
export class CreditTransactionRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /**
   * Runs the running-balance read + insert inside its own transaction
   * when the caller didn't already hand us a `PoolClient` (i.e. isn't
   * already managing a transaction itself) — mirroring this codebase's
   * established `withTenantScope`-style pattern (HealthDashboardRepository)
   * for "acquire a dedicated client, do work, release" when the caller
   * passed a bare Pool or nothing at all.
   */
  async recordTransaction(client: Pool | PoolClient | undefined, tenantId: string, input: RecordTransactionInput): Promise<CreditTransaction> {
    if (client && "release" in client) {
      return this.insertLocked(client, tenantId, input);
    }

    const scoped = await this.pool.connect();
    try {
      await scoped.query("BEGIN");
      const result = await this.insertLocked(scoped, tenantId, input);
      await scoped.query("COMMIT");
      return result;
    } catch (err) {
      await scoped.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      scoped.release();
    }
  }

  private async insertLocked(client: PoolClient, tenantId: string, input: RecordTransactionInput): Promise<CreditTransaction> {
    const lockKey = `credit_balance:${tenantId}:${input.teamId ?? ""}`;
    await client.query(ADVISORY_LOCK_SQL, [lockKey]);

    const priorResult = await client.query<{ running_balance: number }>(
      "SELECT running_balance FROM credit_transactions WHERE tenant_id = $1 AND team_id IS NOT DISTINCT FROM $2 ORDER BY created_at DESC, id DESC LIMIT 1",
      [tenantId, input.teamId],
    );
    const priorBalance = priorResult.rows[0]?.running_balance ?? 0;
    const delta = input.entryType === "credit" ? input.amount : -input.amount;
    const newBalance = priorBalance + delta;

    const creditsDebit = input.entryType === "debit" ? input.amount : 0;
    const creditsCredit = input.entryType === "credit" ? input.amount : 0;

    const result = await client.query<TransactionRow>(
      `INSERT INTO credit_transactions (tenant_id, team_id, agent_id, credits_debit, credits_credit, running_balance, action_type, description, actor_id, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [tenantId, input.teamId, input.agentId, creditsDebit, creditsCredit, newBalance, input.actionType, input.description, input.actorId, input.occurredAt ?? new Date()],
    );
    return toDomain(result.rows[0]);
  }

  /**
   * Reads from `credit_balances_scoped` (the tenant-scoped materialized-
   * view wrapper) — like every other `_scoped` view in this codebase,
   * its own WHERE clause requires `app.current_tenant` to be set on the
   * connection, so this acquires a dedicated client and sets it when the
   * caller didn't already provide one with that context (mirroring
   * CalibrationService.withTenantScope's exact reasoning/pattern).
   */
  async getBalance(client: Pool | PoolClient | undefined, tenantId: string, teamId: string | null): Promise<CreditBalance | null> {
    const result = await this.withTenantScope(client, tenantId, (executor) =>
      executor.query<BalanceRow>("SELECT * FROM credit_balances_scoped WHERE tenant_id = $1 AND team_id IS NOT DISTINCT FROM $2", [tenantId, teamId]),
    );
    return result.rows[0] ? toBalanceDomain(result.rows[0]) : null;
  }

  async refreshBalances(client?: Pool | PoolClient): Promise<void> {
    const executor = client ?? this.pool;
    try {
      await executor.query("REFRESH MATERIALIZED VIEW CONCURRENTLY credit_balances");
    } catch {
      await executor.query("REFRESH MATERIALIZED VIEW credit_balances");
    }
  }

  async getTransactionHistory(client: Pool | PoolClient | undefined, tenantId: string, filters: TransactionHistoryFilters): Promise<{ rows: CreditTransaction[]; total: number }> {
    const executor = client ?? this.pool;
    const conditions = ["tenant_id = $1"];
    const params: unknown[] = [tenantId];

    if (filters.agentId) {
      params.push(filters.agentId);
      conditions.push(`agent_id = $${params.length}`);
    }
    if (filters.teamId) {
      params.push(filters.teamId);
      conditions.push(`team_id = $${params.length}`);
    }
    if (filters.actionType) {
      params.push(filters.actionType);
      conditions.push(`action_type = $${params.length}`);
    }
    if (filters.startDate) {
      params.push(filters.startDate);
      conditions.push(`occurred_at >= $${params.length}`);
    }
    if (filters.endDate) {
      params.push(filters.endDate);
      conditions.push(`occurred_at <= $${params.length}`);
    }

    const whereClause = conditions.join(" AND ");
    const countResult = await executor.query<{ count: string }>(`SELECT count(*) FROM credit_transactions WHERE ${whereClause}`, params);

    const rows = await executor.query<TransactionRow>(
      `SELECT * FROM credit_transactions WHERE ${whereClause} ORDER BY occurred_at DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filters.limit, filters.offset],
    );

    return { total: Number(countResult.rows[0].count), rows: rows.rows.map(toDomain) };
  }

  /**
   * A bare `Pool` (as opposed to a `PoolClient`) is never "already
   * scoped" — a `Pool` hands out a fresh, unconfigured connection per
   * `.query()` call, so `app.current_tenant` must be set here regardless
   * of whether the caller passed one in. Only a real `PoolClient` (has
   * `.release()`) is trusted as "the caller already set this up on this
   * exact connection" — matching `recordTransaction`'s own Pool-vs-
   * PoolClient duck-typing check above.
   */
  private async withTenantScope<T>(client: Pool | PoolClient | undefined, tenantId: string, fn: (executor: Pool | PoolClient) => Promise<T>): Promise<T> {
    if (client && "release" in client) return fn(client);
    const scoped = await this.pool.connect();
    try {
      await scoped.query("SELECT set_config('app.current_tenant', $1, false)", [tenantId]);
      return await fn(scoped);
    } finally {
      scoped.release();
    }
  }
}
