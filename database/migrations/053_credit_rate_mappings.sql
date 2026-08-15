-- WO-066: real-time credit metering engine — action-to-credit rate
-- mapping and a foundational per-team hard cap concept (formalized
-- further by WO-070's own "Hard Cap Enforcement" story; a nullable
-- hard_cap here just gives THIS WO's near-cap fallthrough logic
-- something real to reference without inventing WO-070's full scope).

CREATE TABLE credit_rate_mappings (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    action_type       VARCHAR(64) NOT NULL,
    credits_per_unit  NUMERIC(12, 4) NOT NULL CHECK (credits_per_unit >= 0),
    effective_from    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- NULL = still in effect indefinitely.
    effective_until   TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT credit_rate_mappings_valid_range CHECK (effective_until IS NULL OR effective_until > effective_from)
);

CREATE INDEX idx_credit_rate_mappings_lookup ON credit_rate_mappings (tenant_id, action_type, effective_from);
SELECT enable_tenant_isolation('credit_rate_mappings');
GRANT SELECT, INSERT, UPDATE ON credit_rate_mappings TO ams_app;

-- Foundational per-team spend ceiling for the metering engine's own
-- near-cap fallthrough decision (AC: "within 5% of the hard cap"). NULL
-- hard_cap = no cap configured yet — the engine always uses the fast
-- cache-only path in that case. WO-070 will build the actual
-- configuration/management surface on top of this same table.
CREATE TABLE team_credit_limits (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    team_id    UUID NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
    hard_cap   INTEGER CHECK (hard_cap IS NULL OR hard_cap >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT unique_team_credit_limit UNIQUE (tenant_id, team_id)
);

SELECT enable_tenant_isolation('team_credit_limits');
GRANT SELECT, INSERT, UPDATE ON team_credit_limits TO ams_app;
