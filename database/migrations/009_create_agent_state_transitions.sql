CREATE TABLE agent_state_transitions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    agent_id      UUID NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    from_status   TEXT NOT NULL,
    to_status     TEXT NOT NULL,
    reason        TEXT,
    triggered_by  UUID REFERENCES users (id) ON DELETE SET NULL,
    occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_agent_state_transitions_tenant_agent ON agent_state_transitions (tenant_id, agent_id, occurred_at);

SELECT enable_tenant_isolation('agent_state_transitions');

-- Transitions are a history log, same append-only reasoning as
-- audit_events, just without the hash chain (that's audit_events' job —
-- every state transition also gets its own audit_events row).
GRANT SELECT, INSERT ON agent_state_transitions TO ams_app;
