-- WO-016 (Four-Tier Data Classification Taxonomy) names its four tiers
-- PUBLIC/INTERNAL/CONFIDENTIAL/RESTRICTED, but migration 005 already
-- created audit_events.data_classification with a 4th tier named 'phi'
-- instead of 'restricted'. Reconciling this before WO-016's application
-- code lands, rather than making the app-layer enum silently alias to a
-- differently-named DB value, which would be a permanent, confusing
-- mismatch between the domain model and the schema every future reader
-- has to know about. Safe to rename outright here: this is greenfield
-- (no production data), and the only rows using 'phi' anywhere in this
-- repo are in a local test fixture, updated below along with the
-- constraint itself.

UPDATE audit_events SET data_classification = 'restricted' WHERE data_classification = 'phi';

ALTER TABLE audit_events DROP CONSTRAINT audit_events_data_classification_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_data_classification_check
    CHECK (data_classification IN ('public', 'internal', 'confidential', 'restricted'));
-- CHECK constraints on a partitioned table's parent apply to every
-- existing and future partition automatically — no per-partition ALTER
-- needed.
