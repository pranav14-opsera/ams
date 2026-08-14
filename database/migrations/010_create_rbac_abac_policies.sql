CREATE TABLE rbac_policies (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    role        TEXT NOT NULL CHECK (role IN ('platform_admin', 'compliance_officer', 'finance_manager', 'team_lead', 'agent_operator')),
    permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (tenant_id, role)
);

CREATE INDEX idx_rbac_policies_tenant_id ON rbac_policies (tenant_id);
SELECT enable_tenant_isolation('rbac_policies');
GRANT SELECT, INSERT, UPDATE, DELETE ON rbac_policies TO ams_app;

CREATE TABLE abac_policies (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    -- Context attributes evaluated at authorization time: time window,
    -- location/CIDR, device trust level, data classification, agent
    -- behavioral risk score (see REQ-015 / WO-088).
    conditions  JSONB NOT NULL DEFAULT '{}'::jsonb,
    effect      TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
    priority    INT NOT NULL DEFAULT 100,
    enabled     BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (tenant_id, name)
);

CREATE INDEX idx_abac_policies_tenant_enabled_priority ON abac_policies (tenant_id, enabled, priority);
SELECT enable_tenant_isolation('abac_policies');
GRANT SELECT, INSERT, UPDATE, DELETE ON abac_policies TO ams_app;
