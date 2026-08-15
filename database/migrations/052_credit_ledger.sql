-- WO-065: credit ledger with double-entry accounting.
--
-- Migration 011 already created a `credit_transactions` table (also
-- labeled "WO-065" in its own comment) but with a different shape: a
-- single `entry_type` (debit|credit) + `amount` column pair, no
-- `actor_id`, no `created_at`, `amount` as NUMERIC rather than INTEGER.
-- WO-065's own AC is explicit and literal about the column list this
-- table must have (`credits_debit`, `credits_credit`, `running_balance`
-- as separate INTEGER columns, `action_type`, `description`,
-- `actor_id`), and multiple downstream credit-metering work orders
-- (WO-066 through WO-073) will depend on these exact names. The old
-- table was never referenced by any application code (grepped clean) —
-- replaced here rather than carrying two divergent, dead schemas
-- forward. Note this is a "debit/credit column pair with a running
-- balance" ledger style (each transaction is one row, one side
-- populated, matching a bank-statement/expense-ledger convention) as
-- the AC literally specifies, not classic multi-account double-entry
-- (two linked, opposite-signed rows per transaction) — both are valid
-- "double-entry" namings in practice; implemented exactly as the AC's
-- own column list describes.
DROP TABLE IF EXISTS credit_transactions CASCADE;

CREATE TABLE credit_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    team_id         UUID REFERENCES teams (id) ON DELETE SET NULL,
    agent_id        UUID REFERENCES agents (id) ON DELETE SET NULL,
    credits_debit   INTEGER NOT NULL DEFAULT 0 CHECK (credits_debit >= 0),
    credits_credit  INTEGER NOT NULL DEFAULT 0 CHECK (credits_credit >= 0),
    -- The ledger balance immediately after this transaction is applied — computed and stamped at insert time (never recomputed later), so a row is a permanent, self-describing point-in-time fact.
    running_balance INTEGER NOT NULL,
    action_type     VARCHAR(64) NOT NULL,
    description     TEXT,
    actor_id        UUID,
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Exactly one side of the pair is ever populated per row — a transaction is either a debit or a credit, never both, never neither.
    CONSTRAINT credit_transactions_exactly_one_side CHECK (
        (credits_debit > 0 AND credits_credit = 0) OR (credits_debit = 0 AND credits_credit > 0)
    )
);

CREATE INDEX idx_credit_transactions_tenant_team_time ON credit_transactions (tenant_id, team_id, occurred_at);
CREATE INDEX idx_credit_transactions_tenant_agent_time ON credit_transactions (tenant_id, agent_id, occurred_at);
CREATE INDEX idx_credit_transactions_tenant_action_time ON credit_transactions (tenant_id, action_type, occurred_at);

SELECT enable_tenant_isolation('credit_transactions');
GRANT SELECT, INSERT ON credit_transactions TO ams_app;

-- AC: "credit_balances materialized view aggregates net balance per
-- tenant_id and team_id ... refreshable on demand" — same native-
-- partitioning-not-required / plain-materialized-view substitute this
-- codebase has used since migration 007 in place of a TimescaleDB
-- continuous aggregate (unavailable on RDS).
CREATE MATERIALIZED VIEW credit_balances AS
SELECT
    tenant_id,
    team_id,
    sum(credits_credit - credits_debit) AS net_balance,
    count(*) AS transaction_count,
    max(occurred_at) AS last_transaction_at
FROM credit_transactions
GROUP BY tenant_id, team_id
WITH NO DATA;

-- team_id is nullable, but GROUP BY already collapses every NULL-team row
-- for a given tenant into exactly one output row (Postgres GROUP BY
-- treats all NULLs as one group) — so this plain (tenant_id, team_id)
-- unique index is safe for REFRESH MATERIALIZED VIEW CONCURRENTLY
-- despite the nullable column, with no COALESCE/sentinel-value trick
-- needed.
CREATE UNIQUE INDEX idx_credit_balances_pk ON credit_balances (tenant_id, team_id);
CREATE VIEW credit_balances_scoped AS
SELECT * FROM credit_balances WHERE tenant_id = current_setting('app.current_tenant', true)::uuid;
REVOKE ALL ON credit_balances FROM PUBLIC;
GRANT SELECT ON credit_balances_scoped TO ams_app;
