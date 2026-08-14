CREATE TABLE governance_rules (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    trigger     JSONB NOT NULL DEFAULT '{}'::jsonb, -- condition(s) that pause an agent for approval
    action      TEXT NOT NULL DEFAULT 'require_approval' CHECK (action IN ('require_approval', 'block', 'notify_only')),
    enabled     BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (tenant_id, name)
);

CREATE INDEX idx_governance_rules_tenant_enabled ON governance_rules (tenant_id, enabled);
SELECT enable_tenant_isolation('governance_rules');
GRANT SELECT, INSERT, UPDATE, DELETE ON governance_rules TO ams_app;

CREATE TABLE approval_requests (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    agent_id          UUID NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
    governance_rule_id UUID REFERENCES governance_rules (id) ON DELETE SET NULL,
    status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
    requested_action  JSONB NOT NULL DEFAULT '{}'::jsonb,
    decided_by        UUID REFERENCES users (id) ON DELETE SET NULL,
    decided_at        TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_approval_requests_tenant_status ON approval_requests (tenant_id, status);
SELECT enable_tenant_isolation('approval_requests');
GRANT SELECT, INSERT, UPDATE ON approval_requests TO ams_app;
