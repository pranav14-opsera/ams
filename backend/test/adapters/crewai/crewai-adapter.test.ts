import { test } from "node:test";
import assert from "node:assert/strict";
import { CrewAiAdapter } from "../../../src/adapters/crewai/crewai-adapter";
import { CrewAiConnectionValidator } from "../../../src/adapters/crewai/crewai-connection-validator";
import { TelemetryEventType } from "../../../src/adapters/schemas/canonical-telemetry";
import { TelemetrySchemaValidatorService } from "../../../src/adapters/telemetry-schema-validator.service";
import * as fixtures from "./fixtures/crewai-event-payloads";

function buildAdapter(): CrewAiAdapter {
  return new CrewAiAdapter(new CrewAiConnectionValidator());
}

test("getAdapterMetadata reports crewai and TRACE/METRIC/ERROR support", () => {
  const metadata = buildAdapter().getAdapterMetadata();
  assert.equal(metadata.frameworkType, "crewai");
  assert.deepEqual(new Set(metadata.supportedEventTypes), new Set([TelemetryEventType.TRACE, TelemetryEventType.METRIC, TelemetryEventType.ERROR]));
});

test("crew_kickoff translates to TRACE with crewId in metadata and no parent", () => {
  const adapter = buildAdapter();
  const result = adapter.translateTelemetry(fixtures.envelope(fixtures.CREW_KICKOFF));
  assert.equal(result.event_type, TelemetryEventType.TRACE);
  assert.equal(result.latency_ms, null);
  assert.equal((result.metadata as any).crewId, "crew-001");
  assert.equal((result.metadata as any).parentEventId, null);
});

test("crew_completed computes latency from the correlated crew_kickoff and extracts token usage", () => {
  const adapter = buildAdapter();
  const env = fixtures.envelope(fixtures.CREW_KICKOFF);
  adapter.translateTelemetry(env);
  const result = adapter.translateTelemetry({ ...env, event: fixtures.CREW_COMPLETED });
  assert.equal(result.event_type, TelemetryEventType.METRIC);
  assert.equal(result.latency_ms, 2500);
  assert.equal(result.token_consumption, 1500);
});

test("task_started's parentEventId is the crew_id (a task is one level below its crew)", () => {
  const adapter = buildAdapter();
  const result = adapter.translateTelemetry(fixtures.envelope(fixtures.TASK_STARTED));
  assert.equal((result.metadata as any).parentEventId, "crew-001");
  assert.equal((result.metadata as any).taskId, "task-001");
  assert.equal((result.metadata as any).agentRole, "researcher");
});

test("task_completed computes latency from the correlated task_started and extracts token usage, independently from crew-level correlation", () => {
  const adapter = buildAdapter();
  const env = fixtures.envelope(fixtures.TASK_STARTED);
  adapter.translateTelemetry(env);
  const result = adapter.translateTelemetry({ ...env, event: fixtures.TASK_COMPLETED });
  assert.equal(result.event_type, TelemetryEventType.METRIC);
  assert.equal(result.latency_ms, 2500);
  assert.equal(result.token_consumption, 600);
});

test("task_failed translates to ERROR with error_rate 1 and the (pre-scrub) message in metadata", () => {
  const adapter = buildAdapter();
  const env = fixtures.envelope(fixtures.TASK_STARTED);
  adapter.translateTelemetry(env);
  const result = adapter.translateTelemetry({ ...env, event: fixtures.TASK_FAILED });
  assert.equal(result.event_type, TelemetryEventType.ERROR);
  assert.equal(result.error_rate, 1);
  assert.match((result.metadata as any).error, /rate limited/);
});

test("agent_action uses its own duration_ms directly (no start/end correlation needed) and its parent is the task", () => {
  const adapter = buildAdapter();
  const result = adapter.translateTelemetry(fixtures.envelope(fixtures.AGENT_ACTION));
  assert.equal(result.event_type, TelemetryEventType.METRIC);
  assert.equal(result.latency_ms, 320);
  assert.equal((result.metadata as any).parentEventId, "task-001");
});

test("tool_usage: success maps to error_rate 0/tool_call_success true, failure maps to error_rate 1/tool_call_success false", () => {
  const adapter = buildAdapter();
  const success = adapter.translateTelemetry(fixtures.envelope(fixtures.TOOL_USAGE));
  assert.equal(success.tool_call_success, true);
  assert.equal(success.error_rate, 0);
  assert.equal(success.tool_call_name, "web_search");

  const failure = adapter.translateTelemetry(fixtures.envelope(fixtures.TOOL_USAGE_FAILURE));
  assert.equal(failure.tool_call_success, false);
  assert.equal(failure.error_rate, 1);
});

test("delegation preserves delegation_from/to/reason in metadata alongside the hierarchy", () => {
  const adapter = buildAdapter();
  const result = adapter.translateTelemetry(fixtures.envelope(fixtures.DELEGATION));
  assert.equal(result.event_type, TelemetryEventType.TRACE);
  const metadata = result.metadata as any;
  assert.equal(metadata.delegationFrom, "manager");
  assert.equal(metadata.delegationTo, "researcher");
  assert.equal(metadata.delegationReason, "requires domain expertise");
  assert.equal(metadata.parentEventId, "task-001");
});

test("a task-scoped event with no task_id falls back to the crew as its parent", () => {
  const adapter = buildAdapter();
  const noTaskAction = { ...fixtures.AGENT_ACTION, task_id: undefined } as any;
  const result = adapter.translateTelemetry(fixtures.envelope(noTaskAction));
  assert.equal((result.metadata as any).parentEventId, "crew-001");
});

test("throws 400 on a malformed envelope", () => {
  const adapter = buildAdapter();
  assert.throws(
    () => adapter.translateTelemetry(fixtures.MALFORMED_ENVELOPE),
    (err: any) => {
      assert.equal(err.getStatus(), 400);
      return true;
    },
  );
});

test("throws 400 on a completely unrecognized event type", () => {
  const adapter = buildAdapter();
  const malformed = { agent_id: "a", tenant_id: "t", adapter_version: "1.0.0", event: { type: "on_something_unheard_of", crew_id: "c", timestamp: new Date().toISOString() } };
  assert.throws(
    () => adapter.translateTelemetry(malformed),
    (err: any) => {
      assert.equal(err.getStatus(), 400);
      return true;
    },
  );
});

test("every event type in a full crew execution trace translates into a canonical-schema-valid event", () => {
  const adapter = buildAdapter();
  const validator = new TelemetrySchemaValidatorService();
  const env = fixtures.envelope(fixtures.CREW_KICKOFF);
  const trace = fixtures.fullCrewExecutionTrace();
  assert.equal(trace.length, 6);
  for (const event of trace) {
    const result = validator.validate(adapter.translateTelemetry({ ...env, event }));
    assert.equal(result.valid, true, `${event.type} must translate into a schema-valid canonical event: ${result.errors.join("; ")}`);
  }
});

test("the full crew execution trace's hierarchy reconstructs correctly: crew (root) -> task (parent=crew) -> tool_usage/delegation (parent=task)", () => {
  const adapter = buildAdapter();
  const env = fixtures.envelope(fixtures.CREW_KICKOFF);
  const results = fixtures.fullCrewExecutionTrace().map((event) => adapter.translateTelemetry({ ...env, event }));

  const [kickoff, taskStarted, delegation, toolUsage, taskCompleted, crewCompleted] = results;
  assert.equal((kickoff.metadata as any).parentEventId, null);
  assert.equal((taskStarted.metadata as any).parentEventId, "crew-001");
  assert.equal((delegation.metadata as any).parentEventId, "task-001");
  assert.equal((toolUsage.metadata as any).parentEventId, "task-001");
  assert.equal((taskCompleted.metadata as any).parentEventId, "crew-001");
  assert.equal((crewCompleted.metadata as any).parentEventId, null);
});
