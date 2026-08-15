-- WO-057: execution trace storage. The `agent_management:trace:view_all`
-- / `agent_management:trace:view_assigned` permissions have existed
-- since rbac.constants.ts's own seed migration (024) but nothing has
-- ever backed them with real data — this is the first WO to actually
-- give them something to gate access to.

CREATE TABLE agent_execution_traces (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    agent_id          UUID NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    status            TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
    started_at        TIMESTAMPTZ NOT NULL,
    duration_ms       INTEGER,
    -- Array of {"stepName": text, "toolName": text|null, "durationMs": int,
    -- "status": "success"|"error", "inputSummary": text, "outputSummary": text}.
    -- inputSummary/outputSummary are free text captured from the agent's
    -- own execution — PHI-scrubbed at READ time (TraceService), not at
    -- write time, so the raw (pre-scrub) record remains available for a
    -- genuine compliance audit trail rather than being irreversibly
    -- destroyed on ingest. Same "scrub at the boundary, not at rest"
    -- posture is a deliberate WO-057 design choice — see
    -- TraceService's own doc comment.
    steps             JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_execution_traces_tenant_agent_started ON agent_execution_traces (tenant_id, agent_id, started_at DESC);

SELECT enable_tenant_isolation('agent_execution_traces');
