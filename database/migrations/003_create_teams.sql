CREATE TABLE teams (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    created_by  UUID REFERENCES users (id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (tenant_id, name)
);

CREATE INDEX idx_teams_tenant_id ON teams (tenant_id);

CREATE TABLE team_members (
    team_id   UUID NOT NULL REFERENCES teams (id) ON DELETE CASCADE,
    user_id   UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    role      TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('lead', 'member')),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (team_id, user_id)
);

CREATE INDEX idx_team_members_tenant_id ON team_members (tenant_id);
CREATE INDEX idx_team_members_user_id ON team_members (user_id);
