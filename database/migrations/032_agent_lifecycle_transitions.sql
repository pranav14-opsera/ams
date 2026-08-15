-- WO-032: agent lifecycle state machine.
--
-- agent_state_transitions itself already exists (migration 009,
-- predating this WO) with exactly the columns this WO's acceptance
-- criteria need (agent_id, triggered_by/actor, from_status/to_status,
-- reason/justification, occurred_at) — this migration only adds what's
-- genuinely new: a version column on agents for optimistic-lock
-- concurrency control on transitions, and two columns recording the
-- "paused with incomplete in-flight operations" warning case (AC: "the
-- agent status is set to Paused with a warning flag and the incomplete
-- operations are logged").
ALTER TABLE agents
    ADD COLUMN version INT NOT NULL DEFAULT 1;

ALTER TABLE agent_state_transitions
    ADD COLUMN warning_flag BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN incomplete_operations_count INT;
