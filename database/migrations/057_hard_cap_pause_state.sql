-- WO-070: enforce hard credit cap with agent pause. Tracks exactly which
-- agents were auto-paused BY hard-cap enforcement (as opposed to a
-- manual operator pause via WO-032's LifecycleService) so that only
-- those agents are ever auto-resumed, and only once consumption drops
-- back below the team's cap.

CREATE TABLE hard_cap_pause_state (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    team_id    UUID NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
    agent_id   UUID NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    paused_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- An agent can only ever be tracked once as "currently auto-paused"
    -- at a time — resuming deletes its row before it could be re-paused.
    CONSTRAINT unique_hard_cap_pause_per_agent UNIQUE (tenant_id, agent_id)
);

CREATE INDEX idx_hard_cap_pause_state_team ON hard_cap_pause_state (tenant_id, team_id);

SELECT enable_tenant_isolation('hard_cap_pause_state');
GRANT SELECT, INSERT, DELETE ON hard_cap_pause_state TO ams_app;
