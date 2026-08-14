-- Seed data for local development and CI: 3 tenants, 10 users, 5 teams,
-- 20 agents, 100 audit events, plus enough rows in the other tenant-scoped
-- tables for tests/test_rls_isolation.sql to have something to check.
--
-- Run as postgres/superuser (bypasses RLS to seed multiple tenants'
-- worth of data in one script) — never run this against a real
-- environment's database.

INSERT INTO tenants (id, name, slug) VALUES
    ('11111111-1111-1111-1111-111111111111', 'Acme Health', 'acme-health'),
    ('22222222-2222-2222-2222-222222222222', 'Beacon Medical', 'beacon-medical'),
    ('33333333-3333-3333-3333-333333333333', 'Cascade Clinics', 'cascade-clinics')
ON CONFLICT DO NOTHING;

-- 10 users spread across the 3 tenants (4/3/3)
INSERT INTO users (id, tenant_id, email, display_name)
SELECT
    ('aaaaaaaa-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
    CASE
        WHEN n <= 4 THEN '11111111-1111-1111-1111-111111111111'
        WHEN n <= 7 THEN '22222222-2222-2222-2222-222222222222'
        ELSE '33333333-3333-3333-3333-333333333333'
    END::uuid,
    'user' || n || '@example.com',
    'Test User ' || n
FROM generate_series(1, 10) AS n
ON CONFLICT DO NOTHING;

-- 5 teams (2/2/1)
INSERT INTO teams (id, tenant_id, name)
SELECT
    ('bbbbbbbb-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
    CASE
        WHEN n <= 2 THEN '11111111-1111-1111-1111-111111111111'
        WHEN n <= 4 THEN '22222222-2222-2222-2222-222222222222'
        ELSE '33333333-3333-3333-3333-333333333333'
    END::uuid,
    'Team ' || n
FROM generate_series(1, 5) AS n
ON CONFLICT DO NOTHING;

INSERT INTO team_members (team_id, user_id, tenant_id, role)
SELECT
    ('bbbbbbbb-0000-0000-0000-' || lpad('1', 12, '0'))::uuid,
    ('aaaaaaaa-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
    '11111111-1111-1111-1111-111111111111',
    'member'
FROM generate_series(1, 4) AS n
ON CONFLICT DO NOTHING;

-- 20 agents (8/7/5), each on the matching tenant's first team
INSERT INTO agents (id, tenant_id, team_id, name, framework, lifecycle_status)
SELECT
    ('cccccccc-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
    tenant,
    team,
    'agent-' || n,
    (ARRAY['langchain', 'crewai', 'autogen', 'generic_rest'])[1 + (n % 4)],
    (ARRAY['connecting', 'active', 'active', 'active', 'paused'])[1 + (n % 5)]
FROM (
    SELECT
        n,
        CASE WHEN n <= 8 THEN '11111111-1111-1111-1111-111111111111'
             WHEN n <= 15 THEN '22222222-2222-2222-2222-222222222222'
             ELSE '33333333-3333-3333-3333-333333333333' END::uuid AS tenant,
        CASE WHEN n <= 8 THEN ('bbbbbbbb-0000-0000-0000-' || lpad('1', 12, '0'))::uuid
             WHEN n <= 15 THEN ('bbbbbbbb-0000-0000-0000-' || lpad('3', 12, '0'))::uuid
             ELSE ('bbbbbbbb-0000-0000-0000-' || lpad('5', 12, '0'))::uuid END AS team
    FROM generate_series(1, 20) AS n
) sub
ON CONFLICT DO NOTHING;

-- 100 audit events (40/35/25), hash chain computed automatically by the
-- trigger from migration 005 — no need to set prev_hash/record_hash here.
INSERT INTO audit_events (tenant_id, actor_id, action, resource_type, resource_id, occurred_at)
SELECT
    tenant,
    NULL,
    (ARRAY['login', 'view_agent', 'update_agent', 'view_dashboard'])[1 + (n % 4)],
    'agent',
    NULL,
    now() - (n || ' minutes')::interval
FROM (
    SELECT
        n,
        CASE WHEN n <= 40 THEN '11111111-1111-1111-1111-111111111111'
             WHEN n <= 75 THEN '22222222-2222-2222-2222-222222222222'
             ELSE '33333333-3333-3333-3333-333333333333' END::uuid AS tenant
    FROM generate_series(1, 100) AS n
) sub;

-- A handful of rows in the remaining tenant-scoped tables so
-- test_rls_isolation.sql has non-empty data to check for every table.
INSERT INTO agent_metrics (tenant_id, agent_id, metric_name, value)
SELECT
    '11111111-1111-1111-1111-111111111111',
    ('cccccccc-0000-0000-0000-' || lpad('1', 12, '0'))::uuid,
    'latency_ms', 120 + n
FROM generate_series(1, 5) AS n;

INSERT INTO agent_state_transitions (tenant_id, agent_id, from_status, to_status)
VALUES (
    '11111111-1111-1111-1111-111111111111',
    ('cccccccc-0000-0000-0000-' || lpad('1', 12, '0'))::uuid,
    'connecting', 'active'
);

INSERT INTO rbac_policies (tenant_id, role, permissions)
VALUES ('11111111-1111-1111-1111-111111111111', 'team_lead', '["agents:read", "agents:write"]'::jsonb)
ON CONFLICT DO NOTHING;

INSERT INTO credit_transactions (tenant_id, entry_type, amount, balance_after, reason)
VALUES ('11111111-1111-1111-1111-111111111111', 'debit', 10.5, 989.5, 'agent execution');
