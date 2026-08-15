import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_LIFECYCLE_STATUSES } from "../../src/agents/dto/list-agents-query.dto";
import { isValidTransition, validTransitionsFrom } from "../../src/agents/lifecycle-state-machine";

const VALID_PAIRS: Array<[string, string]> = [
  ["connecting", "active"],
  ["active", "paused"],
  ["active", "retired"],
  ["paused", "active"],
  ["paused", "retired"],
  ["retired", "decommissioned"],
  ["connecting", "decommissioned"],
];

test("accepts exactly the 7 documented valid transitions", () => {
  for (const [from, to] of VALID_PAIRS) {
    assert.equal(isValidTransition(from as any, to as any), true, `${from}->${to} must be valid`);
  }
});

test("rejects every pair not in the documented valid list, including Decommissioned->Active and Paused->Connecting", () => {
  let invalidCount = 0;
  for (const from of AGENT_LIFECYCLE_STATUSES) {
    for (const to of AGENT_LIFECYCLE_STATUSES) {
      const isDocumentedValid = VALID_PAIRS.some(([f, t]) => f === from && t === to);
      if (isDocumentedValid) continue;
      invalidCount++;
      assert.equal(isValidTransition(from, to), false, `${from}->${to} must be invalid`);
    }
  }
  assert.ok(invalidCount >= 10, "at least 10 invalid transitions must be exercised");
});

test("decommissioned has no valid outbound transitions", () => {
  assert.deepEqual(validTransitionsFrom("decommissioned"), []);
});

test("validTransitionsFrom reports the same set isValidTransition agrees with", () => {
  for (const from of AGENT_LIFECYCLE_STATUSES) {
    const valid = validTransitionsFrom(from);
    for (const to of AGENT_LIFECYCLE_STATUSES) {
      assert.equal(valid.includes(to), isValidTransition(from, to));
    }
  }
});
