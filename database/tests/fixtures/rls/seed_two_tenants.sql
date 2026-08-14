-- WO-014 acceptance criteria: "Test fixtures with seed data for two
-- distinct tenants across all 11 tables are committed to the repository"
-- with "100+ rows per table per tenant". This is deliberately separate
-- from database/seeds/test_data.sql (that file is a small, realistic dev
-- seed across 3 tenants; this one is a dedicated, bulk, two-tenant
-- adversarial-testing fixture).
--
-- Row ids are deterministic (md5(seed)::uuid — Postgres accepts a 32-hex
-- digit string, with or without hyphens, as a uuid literal) rather than
-- gen_random_uuid(), so that test scripts (SQL or shell) can independently
-- recompute the same id for a given tenant/table/n without querying for
-- it first, e.g. `echo -n "agents|A|1" | md5sum`.
--
-- Run as postgres/superuser (bypasses RLS to seed two tenants' worth of
-- data in one script) — never run this against a real environment.
--
-- Deletes any prior rows for these two tenants first, in FK-safe order,
-- so re-running this script is idempotent and always yields exactly the
-- row counts documented below.

CREATE OR REPLACE FUNCTION fixture_uuid(seed text) RETURNS uuid AS $$
    SELECT md5(seed)::uuid;
$$ LANGUAGE sql IMMUTABLE;

\set tenant_a '11111111-1111-1111-1111-111111111111'
\set tenant_b '22222222-2222-2222-2222-222222222222'

DELETE FROM audit_events WHERE tenant_id IN (:'tenant_a', :'tenant_b');
DELETE FROM approval_requests WHERE tenant_id IN (:'tenant_a', :'tenant_b');
DELETE FROM governance_rules WHERE tenant_id IN (:'tenant_a', :'tenant_b');
DELETE FROM credit_transactions WHERE tenant_id IN (:'tenant_a', :'tenant_b');
DELETE FROM agent_state_transitions WHERE tenant_id IN (:'tenant_a', :'tenant_b');
DELETE FROM abac_policies WHERE tenant_id IN (:'tenant_a', :'tenant_b');
DELETE FROM rbac_policies WHERE tenant_id IN (:'tenant_a', :'tenant_b');
DELETE FROM dsr_requests WHERE tenant_id IN (:'tenant_a', :'tenant_b');
DELETE FROM agents WHERE tenant_id IN (:'tenant_a', :'tenant_b');
DELETE FROM teams WHERE tenant_id IN (:'tenant_a', :'tenant_b');
DELETE FROM users WHERE tenant_id IN (:'tenant_a', :'tenant_b');

INSERT INTO tenants (id, name, slug, data_residency_region, status)
VALUES
    (:'tenant_a', 'RLS Fixture Tenant A', 'rls-fixture-tenant-a', 'us', 'active'),
    (:'tenant_b', 'RLS Fixture Tenant B', 'rls-fixture-tenant-b', 'us', 'active')
ON CONFLICT (id) DO NOTHING;

-- 100 users per tenant
INSERT INTO users (id, tenant_id, email, display_name)
SELECT fixture_uuid('users|' || t.label || '|' || n), t.id, 'user-' || n || '@' || t.label || '.fixture.test', 'Fixture User ' || n
FROM generate_series(1, 100) AS n
CROSS JOIN (VALUES (:'tenant_a'::uuid, 'A'), (:'tenant_b'::uuid, 'B')) AS t (id, label);

-- 100 teams per tenant
INSERT INTO teams (id, tenant_id, name)
SELECT fixture_uuid('teams|' || t.label || '|' || n), t.id, 'Fixture Team ' || t.label || ' ' || n
FROM generate_series(1, 100) AS n
CROSS JOIN (VALUES (:'tenant_a'::uuid, 'A'), (:'tenant_b'::uuid, 'B')) AS t (id, label);

-- 100 agents per tenant, each on one of that tenant's 100 teams and
-- created by one of that tenant's 100 users (same n, so it's a stable
-- 1:1:1 mapping — enough referential richness for cross-table join
-- testing without needing a separate many-to-many generator).
INSERT INTO agents (id, tenant_id, team_id, name, framework, lifecycle_status, created_by)
SELECT
    fixture_uuid('agents|' || t.label || '|' || n),
    t.id,
    fixture_uuid('teams|' || t.label || '|' || n),
    'Fixture Agent ' || t.label || ' ' || n,
    (ARRAY['langchain', 'crewai', 'autogen', 'generic_rest'])[1 + (n % 4)],
    (ARRAY['connecting', 'active', 'active', 'active', 'paused'])[1 + (n % 5)],
    fixture_uuid('users|' || t.label || '|' || n)
FROM generate_series(1, 100) AS n
CROSS JOIN (VALUES (:'tenant_a'::uuid, 'A'), (:'tenant_b'::uuid, 'B')) AS t (id, label);

-- 100 agent_state_transitions per tenant, each against the matching
-- fixture agent.
INSERT INTO agent_state_transitions (tenant_id, agent_id, from_status, to_status)
SELECT
    t.id,
    fixture_uuid('agents|' || t.label || '|' || n),
    'connecting', 'active'
FROM generate_series(1, 100) AS n
CROSS JOIN (VALUES (:'tenant_a'::uuid, 'A'), (:'tenant_b'::uuid, 'B')) AS t (id, label);

-- rbac_policies: exactly 5 per tenant, one per role — NOT 100+. The
-- schema's own UNIQUE (tenant_id, role) constraint (migration 010) caps
-- this table at one row per role per tenant by design (a tenant either
-- has a policy for a given role or doesn't; roles aren't repeatable), so
-- 5 rows/tenant is this table's real, legitimate maximum — not a fixture
-- gap.
INSERT INTO rbac_policies (tenant_id, role, permissions)
SELECT t.id, r.role, '["fixture:read"]'::jsonb
FROM (VALUES ('platform_admin'), ('compliance_officer'), ('finance_manager'), ('team_lead'), ('agent_operator')) AS r (role)
CROSS JOIN (VALUES (:'tenant_a'::uuid, 'A'), (:'tenant_b'::uuid, 'B')) AS t (id, label);

-- 100 abac_policies per tenant
INSERT INTO abac_policies (tenant_id, name, conditions, effect, priority)
SELECT
    t.id,
    'Fixture ABAC Policy ' || t.label || ' ' || n,
    jsonb_build_object('data_classification', (ARRAY['internal', 'confidential', 'restricted'])[1 + (n % 3)]),
    (ARRAY['allow', 'deny'])[1 + (n % 2)],
    100 + n
FROM generate_series(1, 100) AS n
CROSS JOIN (VALUES (:'tenant_a'::uuid, 'A'), (:'tenant_b'::uuid, 'B')) AS t (id, label);

-- 100 credit_transactions per tenant, against the matching fixture agent
INSERT INTO credit_transactions (tenant_id, agent_id, entry_type, amount, balance_after, reason)
SELECT
    t.id,
    fixture_uuid('agents|' || t.label || '|' || n),
    (ARRAY['debit', 'credit'])[1 + (n % 2)],
    10.5,
    1000 - (n * 10.5),
    'fixture agent execution'
FROM generate_series(1, 100) AS n
CROSS JOIN (VALUES (:'tenant_a'::uuid, 'A'), (:'tenant_b'::uuid, 'B')) AS t (id, label);

-- 100 governance_rules per tenant
INSERT INTO governance_rules (tenant_id, name, trigger, action)
SELECT
    t.id,
    'Fixture Governance Rule ' || t.label || ' ' || n,
    jsonb_build_object('threshold', n),
    (ARRAY['require_approval', 'block', 'notify_only'])[1 + (n % 3)]
FROM generate_series(1, 100) AS n
CROSS JOIN (VALUES (:'tenant_a'::uuid, 'A'), (:'tenant_b'::uuid, 'B')) AS t (id, label);

-- 100 approval_requests per tenant, against the matching fixture agent
INSERT INTO approval_requests (tenant_id, agent_id, status, requested_action)
SELECT
    t.id,
    fixture_uuid('agents|' || t.label || '|' || n),
    (ARRAY['pending', 'approved', 'rejected', 'expired'])[1 + (n % 4)],
    jsonb_build_object('action', 'fixture-action-' || n)
FROM generate_series(1, 100) AS n
CROSS JOIN (VALUES (:'tenant_a'::uuid, 'A'), (:'tenant_b'::uuid, 'B')) AS t (id, label);

-- 100 audit_events per tenant, actor = matching fixture user. Hash chain
-- (migration 005) is computed automatically by its own BEFORE INSERT
-- trigger — no prev_hash/record_hash set here.
INSERT INTO audit_events (tenant_id, actor_id, action, resource_type, resource_id, occurred_at)
SELECT
    t.id,
    fixture_uuid('users|' || t.label || '|' || n),
    (ARRAY['login', 'view_agent', 'update_agent', 'view_dashboard'])[1 + (n % 4)],
    'agent',
    fixture_uuid('agents|' || t.label || '|' || n),
    now() - (n || ' minutes')::interval
FROM generate_series(1, 100) AS n
CROSS JOIN (VALUES (:'tenant_a'::uuid, 'A'), (:'tenant_b'::uuid, 'B')) AS t (id, label);

-- 100 dsr_requests per tenant
INSERT INTO dsr_requests (tenant_id, subject_email, request_type, sla_due_at)
SELECT
    t.id,
    'subject-' || n || '@' || t.label || '.fixture.test',
    (ARRAY['access', 'deletion', 'portability', 'correction'])[1 + (n % 4)],
    now() + interval '30 days'
FROM generate_series(1, 100) AS n
CROSS JOIN (VALUES (:'tenant_a'::uuid, 'A'), (:'tenant_b'::uuid, 'B')) AS t (id, label);

DROP FUNCTION fixture_uuid(text);
