-- pgcrypto provides gen_random_uuid() (primary keys) and digest() (the
-- audit_events SHA-256 hash chain in 005). Both are used throughout every
-- subsequent migration, so this must run first.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
