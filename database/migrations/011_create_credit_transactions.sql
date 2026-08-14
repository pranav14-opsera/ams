-- Double-entry credit ledger (WO-065). Append-only for the same reason
-- audit_events is: a financial ledger must never be edited in place, only
-- ever corrected by a new offsetting entry.
CREATE TABLE credit_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    team_id         UUID REFERENCES teams (id) ON DELETE SET NULL,
    agent_id        UUID REFERENCES agents (id) ON DELETE SET NULL,
    entry_type      TEXT NOT NULL CHECK (entry_type IN ('debit', 'credit')),
    amount          NUMERIC(18, 6) NOT NULL CHECK (amount > 0),
    balance_after   NUMERIC(18, 6) NOT NULL,
    reason          TEXT NOT NULL,
    reference_id    UUID, -- links debit/credit pairs of the same logical transaction
    occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_credit_transactions_tenant_time ON credit_transactions (tenant_id, occurred_at);
CREATE INDEX idx_credit_transactions_reference ON credit_transactions (reference_id) WHERE reference_id IS NOT NULL;

SELECT enable_tenant_isolation('credit_transactions');

GRANT SELECT, INSERT ON credit_transactions TO ams_app;
