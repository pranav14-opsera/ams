-- WO-068: per-team credit budget allocation, drawn from an
-- organization-wide, per-period credit pool.

CREATE TABLE organization_credit_pools (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    total_credits     INTEGER NOT NULL CHECK (total_credits >= 0),
    effective_month   INTEGER NOT NULL CHECK (effective_month BETWEEN 1 AND 12),
    effective_year    INTEGER NOT NULL CHECK (effective_year >= 2020),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT unique_pool_per_period UNIQUE (tenant_id, effective_month, effective_year)
);

SELECT enable_tenant_isolation('organization_credit_pools');
GRANT SELECT, INSERT, UPDATE ON organization_credit_pools TO ams_app;

CREATE TABLE credit_budgets (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    team_id             UUID NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
    allocated_credits   INTEGER NOT NULL CHECK (allocated_credits >= 0),
    alert_threshold_75  BOOLEAN NOT NULL DEFAULT true,
    alert_threshold_90  BOOLEAN NOT NULL DEFAULT true,
    -- Team-level hard cap (WO-070's own future config surface builds on this same column — WO-066 already reads a parallel concept from team_credit_limits; that table stays the metering engine's own fast-path cache-refresh source, this one is the finance-facing budget record. Reconciling the two into one is WO-070's scope, not this one's.)
    hard_cap            INTEGER CHECK (hard_cap IS NULL OR hard_cap >= 0),
    effective_month     INTEGER NOT NULL CHECK (effective_month BETWEEN 1 AND 12),
    effective_year      INTEGER NOT NULL CHECK (effective_year >= 2020),
    created_by          UUID,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT unique_budget_per_team_period UNIQUE (tenant_id, team_id, effective_month, effective_year)
);

CREATE INDEX idx_credit_budgets_tenant_period ON credit_budgets (tenant_id, effective_month, effective_year);
SELECT enable_tenant_isolation('credit_budgets');
GRANT SELECT, INSERT, UPDATE ON credit_budgets TO ams_app;
