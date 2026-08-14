CREATE TABLE agents (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    team_id           UUID REFERENCES teams (id) ON DELETE SET NULL,
    name              TEXT NOT NULL,
    framework         TEXT NOT NULL CHECK (framework IN ('langchain', 'crewai', 'autogen', 'generic_rest')),
    lifecycle_status  TEXT NOT NULL DEFAULT 'connecting'
                      CHECK (lifecycle_status IN ('connecting', 'active', 'paused', 'retired', 'decommissioned')),
    connection_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by        UUID REFERENCES users (id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (tenant_id, name)
);

-- Matches WO-004's specified composite index for agent list/filter queries.
CREATE INDEX idx_agents_tenant_team_status ON agents (tenant_id, team_id, lifecycle_status);
