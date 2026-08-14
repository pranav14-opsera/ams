-- Aligns the tenants table with WO-013's tenant provisioning API contract.
-- Renames rather than adds-alongside: keeping both data_residency and
-- data_residency_region (etc.) around would let the two silently drift,
-- and nothing outside migrations 001/002 references the old names (grep
-- confirmed before writing this).

ALTER TABLE tenants RENAME COLUMN data_residency TO data_residency_region;
ALTER TABLE tenants RENAME COLUMN byok_kms_key_arn TO encryption_key_arn;

ALTER TABLE tenants ADD COLUMN settings JSONB NOT NULL DEFAULT '{}'::jsonb;

-- is_active is a GENERATED column, not a second independently-updatable
-- boolean: `status` (active/suspended/offboarding/offboarded) is the real
-- lifecycle state already in migration 001, so a plain sibling column
-- would risk drifting out of sync with it. This still gives the API
-- surface a literal is_active field per the acceptance criteria, derived
-- from the single source of truth.
ALTER TABLE tenants ADD COLUMN is_active BOOLEAN GENERATED ALWAYS AS (status = 'active') STORED;
