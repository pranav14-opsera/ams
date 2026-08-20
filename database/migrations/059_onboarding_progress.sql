-- WO-082: self-service customer onboarding wizard — server-side wizard
-- state so a customer admin can close the browser mid-flow and resume
-- from the last completed step within 7 days (AC: "Wizard state is
-- persisted server-side... resume from the last completed step within
-- 7 days").
--
-- Keyed by tenant_id, NOT a separate pre-tenant "onboarding session id":
-- Step 1 (Organization Setup) itself provisions the tenant via the
-- existing POST /api/v1/tenants route (WO-013's TenantProvisioningSaga),
-- so a tenant row always exists by the time there is anything server-side
-- worth persisting. Step 1's own in-progress form values (org name,
-- region, admin email, before submission) live only in client-side wizard
-- state — there is no tenant_id to key a row by until that submission
-- succeeds. This is a deliberate, documented scope trim (see this WO's
-- reconciliation doc), not an oversight.
--
-- expires_at is fixed at INSERT time (created_at + 7 days) and never
-- extended by later saves — the AC's "resume... within 7 days" is a
-- 7-day window from when onboarding STARTED, not a rolling window that
-- resets on every autosave.
CREATE TABLE onboarding_progress (
    tenant_id        UUID PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
    current_step     INTEGER NOT NULL DEFAULT 1 CHECK (current_step BETWEEN 1 AND 6),
    -- Sensitive fields (OIDC client secret, SCIM bearer token) are never
    -- persisted here in plaintext, or at all — OnboardingService redacts
    -- them to a boolean presence flag before this column is written. The
    -- secrets themselves already have their own durable, encrypted home
    -- (tenant_sso_configs / scim_tokens) by the time a step completes.
    step_data        JSONB NOT NULL DEFAULT '{}'::jsonb,
    completed_steps  INTEGER[] NOT NULL DEFAULT '{}',
    started_by       UUID,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at       TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days')
);

CREATE INDEX idx_onboarding_progress_expires_at ON onboarding_progress (expires_at);

SELECT enable_tenant_isolation('onboarding_progress');
GRANT SELECT, INSERT, UPDATE, DELETE ON onboarding_progress TO ams_app;
