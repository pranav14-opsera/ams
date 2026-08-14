-- Defense-in-depth layer on top of RLS itself (WO-006/WO-014): a write
-- reaching a tenant-scoped table without app.current_tenant set already
-- can't leak or corrupt anything — the tenant_isolation policy's USING
-- clause (tenant_id = NULL::uuid, never true) hides every existing row
-- from UPDATE/DELETE, and its WITH CHECK rejects INSERT outright. But
-- "UPDATE 0 rows" / "DELETE 0 rows" looks identical to a legitimate
-- no-match, so a real application bug (a code path that forgot to run
-- through TenantContextMiddleware) can silently do nothing forever without
-- anyone noticing. This trigger exists to make that condition loud.
--
-- Two real constraints, found by testing this rather than assumed, shaped
-- the final design:
--
-- 1. This MUST be a FOR EACH STATEMENT trigger, not FOR EACH ROW. A
--    row-level trigger only fires for rows the USING clause has already
--    let through — with app.current_tenant unset, USING is false for
--    every row, so zero rows are ever visited and a row-level trigger
--    would never fire for the exact UPDATE/DELETE case it exists to
--    catch. A statement-level trigger fires once per statement
--    regardless of how many (if any) rows end up matching.
--
-- 2. Logging to tenant_context_violations and raising our own exception
--    in the same trigger call is self-defeating for INSERT: Postgres
--    still evaluates the WITH CHECK policy after this BEFORE trigger
--    returns, and independently raises its own "new row violates
--    row-level security policy" error — which aborts the whole
--    transaction and rolls back our logging INSERT right along with it,
--    regardless of whether we raised anything ourselves. Verified this
--    by hand: logging + self-raising left the violations table empty
--    even though the exception fired exactly as expected.
--    RAISE WARNING doesn't have this problem — PostgreSQL writes log
--    output at the moment of the call, independent of whether the
--    surrounding transaction later commits or rolls back — so it's the
--    one signal guaranteed to survive every case, including INSERT's.
--    The table row is best-effort on top of that: it persists for
--    UPDATE/DELETE (a zero-row UPDATE/DELETE is not itself a Postgres
--    error, so nothing aborts the transaction), but for INSERT it will
--    be rolled back together with the doomed insert — which is fine,
--    since INSERT's case is already loudly surfaced to the caller by
--    Postgres's own native RLS error, on top of the WARNING log line.

CREATE TABLE tenant_context_violations (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    table_name   TEXT NOT NULL,
    operation    TEXT NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),
    detail       TEXT NOT NULL,
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Not tenant-scoped and not RLS'd: a violation-by-definition has no
-- reliable tenant_id to scope it to, and this table exists for
-- cross-tenant security monitoring, not per-tenant application data.
CREATE INDEX idx_tenant_context_violations_occurred_at ON tenant_context_violations (occurred_at);

CREATE OR REPLACE FUNCTION tenant_context_violation_guard()
RETURNS trigger AS $$
DECLARE
    current_tenant TEXT;
BEGIN
    current_tenant := current_setting('app.current_tenant', true);

    IF current_tenant IS NULL OR current_tenant = '' THEN
        RAISE WARNING 'tenant_context_violation: % attempted on % with app.current_tenant unset', TG_OP, TG_TABLE_NAME;

        -- Best-effort: see header comment for why this survives for
        -- UPDATE/DELETE but is expected to roll back for INSERT.
        INSERT INTO tenant_context_violations (table_name, operation, detail)
        VALUES (
            TG_TABLE_NAME,
            TG_OP,
            format('%s attempted on %s with app.current_tenant unset', TG_OP, TG_TABLE_NAME)
        );
    END IF;

    RETURN NULL; -- return value is ignored for statement-level triggers
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION attach_tenant_context_guard(target_table regclass)
RETURNS void AS $$
BEGIN
    EXECUTE format(
        'CREATE TRIGGER trg_tenant_context_guard BEFORE INSERT OR UPDATE OR DELETE ON %s
         FOR EACH STATEMENT EXECUTE FUNCTION tenant_context_violation_guard()',
        target_table
    );
END;
$$ LANGUAGE plpgsql;

-- The 11 tenant-scoped tables named in WO-014's acceptance criteria.
-- (team_members and agent_metrics also carry the tenant_isolation RLS
-- policy from earlier migrations but aren't in that list, so they're left
-- out of this trigger too, to keep this migration's scope matching its WO.)
SELECT attach_tenant_context_guard('users');
SELECT attach_tenant_context_guard('teams');
SELECT attach_tenant_context_guard('agents');
SELECT attach_tenant_context_guard('agent_state_transitions');
SELECT attach_tenant_context_guard('rbac_policies');
SELECT attach_tenant_context_guard('abac_policies');
SELECT attach_tenant_context_guard('credit_transactions');
SELECT attach_tenant_context_guard('governance_rules');
SELECT attach_tenant_context_guard('approval_requests');
SELECT attach_tenant_context_guard('audit_events');
SELECT attach_tenant_context_guard('dsr_requests');

GRANT SELECT, INSERT ON tenant_context_violations TO ams_app;
