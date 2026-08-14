-- Tenant registry. Not itself tenant-scoped (it IS the tenant dimension),
-- so no RLS policy applies here — every other table's tenant_id foreign
-- keys into this one.

CREATE TABLE tenants (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name              TEXT NOT NULL,
    slug              TEXT NOT NULL UNIQUE,
    data_residency    TEXT NOT NULL DEFAULT 'us' CHECK (data_residency IN ('us', 'eu')),
    status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'offboarding', 'offboarded')),
    byok_kms_key_arn  TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tenants_status ON tenants (status);
