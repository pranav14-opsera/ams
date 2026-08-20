import { test } from "node:test";
import assert from "node:assert/strict";
import { LifecycleService, DEFAULT_PAUSE_DRAIN_TIMEOUT_MS } from "../../src/agents/lifecycle.service";
import { AGENT_LIFECYCLE_STATUSES } from "../../src/agents/dto/list-agents-query.dto";
import { isValidTransition } from "../../src/agents/lifecycle-state-machine";

function fakeAgentsRepository(initial: { lifecycle_status: string; version: number; [k: string]: unknown }) {
  const agent = { ...initial };
  const casCalls: any[] = [];
  return {
    agent,
    casCalls,
    findOne: async () => ({ ...agent }),
    compareAndSwapLifecycleStatus: async (
      _client: unknown,
      _tenantId: string,
      _id: string,
      expectedStatus: string,
      expectedVersion: number,
      newStatus: string,
    ) => {
      casCalls.push({ expectedStatus, expectedVersion, newStatus });
      if (expectedStatus !== agent.lifecycle_status || expectedVersion !== agent.version) return null;
      agent.lifecycle_status = newStatus;
      agent.version += 1;
      return { ...agent };
    },
  } as any;
}

function fakeTransitionsRepository() {
  const records: any[] = [];
  return { records, record: async (_client: unknown, input: any) => { records.push(input); return { id: "t1", ...input }; } } as any;
}

function fakeAuditService() {
  const events: any[] = [];
  return { events, recordEvent: async (event: any) => { events.push(event); } } as any;
}

function fakeInFlightOperations(drainResult: { drained: boolean; remainingCount: number } = { drained: true, remainingCount: 0 }) {
  const calls: any[] = [];
  return { calls, waitForDrain: async (agentId: string, timeoutMs: number) => { calls.push({ agentId, timeoutMs }); return drainResult; } } as any;
}

function fakePubSub() {
  const published: any[] = [];
  return { published, publish: async (tenantId: string, channel: string, message: unknown) => { published.push({ tenantId, channel, message }); } } as any;
}

function buildService(opts: {
  agent: { lifecycle_status: string; version: number; [k: string]: unknown };
  drainResult?: { drained: boolean; remainingCount: number };
}) {
  const repository = fakeAgentsRepository(opts.agent);
  const transitionsRepository = fakeTransitionsRepository();
  const audit = fakeAuditService();
  const inFlight = fakeInFlightOperations(opts.drainResult);
  const pubsub = fakePubSub();
  const service = new LifecycleService(repository, transitionsRepository, audit, inFlight, pubsub);
  return { service, repository, transitionsRepository, audit, inFlight, pubsub };
}

function baseAgent(status: string, version = 1) {
  return {
    id: "agent-1",
    tenant_id: "tenant-1",
    lifecycle_status: status,
    version,
    created_at: new Date(),
    updated_at: new Date(),
    metadata: {},
    team_id: null,
    name: "Test Agent",
    framework: "langchain",
  };
}

const VALID_TRANSITIONS: Array<[string, string, string | undefined]> = [
  ["connecting", "active", undefined],
  ["active", "paused", undefined],
  ["active", "retired", "no longer needed"],
  ["paused", "active", undefined],
  ["paused", "retired", "no longer needed"],
  ["retired", "decommissioned", "final teardown"],
  ["connecting", "decommissioned", "connection failed permanently"],
];

test("performs every one of the 7 documented valid transitions, persisting the new status", async () => {
  for (const [from, to, justification] of VALID_TRANSITIONS) {
    const { service, repository } = buildService({ agent: baseAgent(from) });
    const result = await service.transition(undefined, "tenant-1", "actor-1", "agent-1", to as any, justification);
    assert.equal(result.agent.lifecycleStatus, to, `${from}->${to} should persist`);
    assert.equal(repository.agent.lifecycle_status, to);
  }
});

test("records an agent_state_transitions entry with agent/actor/previous/new/justification for every transition", async () => {
  const { service, transitionsRepository } = buildService({ agent: baseAgent("active") });
  await service.transition(undefined, "tenant-1", "actor-1", "agent-1", "retired" as any, "shutting down");

  assert.equal(transitionsRepository.records.length, 1);
  const record = transitionsRepository.records[0];
  assert.equal(record.tenantId, "tenant-1");
  assert.equal(record.agentId, "agent-1");
  assert.equal(record.actorId, "actor-1");
  assert.equal(record.fromStatus, "active");
  assert.equal(record.toStatus, "retired");
  assert.equal(record.justification, "shutting down");
  assert.equal(record.warningFlag, false);
});

test("emits an immutable audit event with full context for every transition", async () => {
  const { service, audit } = buildService({ agent: baseAgent("paused") });
  await service.transition(undefined, "tenant-1", "actor-9", "agent-1", "active" as any, undefined);

  assert.equal(audit.events.length, 1);
  const event = audit.events[0];
  assert.equal(event.action, "agent.lifecycle_transition");
  assert.equal(event.tenantId, "tenant-1");
  assert.equal(event.actorId, "actor-9");
  assert.equal(event.resourceId, "agent-1");
  assert.equal(event.details.fromStatus, "paused");
  assert.equal(event.details.toStatus, "active");
});

test("rejects an invalid transition with 409 listing the valid transitions from the current status", async () => {
  const { service } = buildService({ agent: baseAgent("decommissioned") });
  await assert.rejects(
    () => service.transition(undefined, "tenant-1", "actor-1", "agent-1", "active" as any, undefined),
    (err: any) => {
      assert.equal(err.getStatus(), 409);
      assert.match(err.getResponse().message, /Valid transitions from "decommissioned": none/);
      return true;
    },
  );
});

test("rejects Paused->Connecting with 409", async () => {
  const { service } = buildService({ agent: baseAgent("paused") });
  await assert.rejects(
    () => service.transition(undefined, "tenant-1", "actor-1", "agent-1", "connecting" as any, undefined),
    (err: any) => {
      assert.equal(err.getStatus(), 409);
      return true;
    },
  );
});

test("rejects every non-documented transition pair with 409 (10+ invalid transitions exercised)", async () => {
  let exercised = 0;
  for (const from of AGENT_LIFECYCLE_STATUSES) {
    for (const to of AGENT_LIFECYCLE_STATUSES) {
      if (isValidTransition(from, to)) continue;
      exercised++;
      const { service } = buildService({ agent: baseAgent(from) });
      await assert.rejects(
        () => service.transition(undefined, "tenant-1", "actor-1", "agent-1", to as any, "justification"),
        (err: any) => {
          assert.equal(err.getStatus(), 409);
          return true;
        },
      );
    }
  }
  assert.ok(exercised >= 10, `expected at least 10 invalid pairs, got ${exercised}`);
});

test("requires a justification to transition into Retired or Decommissioned", async () => {
  const { service } = buildService({ agent: baseAgent("active") });
  await assert.rejects(
    () => service.transition(undefined, "tenant-1", "actor-1", "agent-1", "retired" as any, undefined),
    (err: any) => {
      assert.equal(err.getStatus(), 400);
      return true;
    },
  );

  const { service: service2 } = buildService({ agent: baseAgent("connecting") });
  await assert.rejects(
    () => service2.transition(undefined, "tenant-1", "actor-1", "agent-1", "decommissioned" as any, "   "),
    (err: any) => {
      assert.equal(err.getStatus(), 400, "a whitespace-only justification must not satisfy the requirement");
      return true;
    },
  );
});

test("does not require justification for transitions that don't need one", async () => {
  const { service } = buildService({ agent: baseAgent("connecting") });
  const result = await service.transition(undefined, "tenant-1", "actor-1", "agent-1", "active" as any, undefined);
  assert.equal(result.agent.lifecycleStatus, "active");
});

test("Active->Paused waits for in-flight operations to drain before finalizing the transition", async () => {
  const { service, inFlight } = buildService({ agent: baseAgent("active"), drainResult: { drained: true, remainingCount: 0 } });
  const result = await service.transition(undefined, "tenant-1", "actor-1", "agent-1", "paused" as any, undefined, 5000);

  assert.equal(inFlight.calls.length, 1);
  assert.equal(inFlight.calls[0].agentId, "agent-1");
  assert.equal(inFlight.calls[0].timeoutMs, 5000);
  assert.equal(result.warning, null);
});

test("if in-flight operations don't drain within the timeout, still pauses but sets a warning flag and logs the incomplete count", async () => {
  const { service, transitionsRepository, audit } = buildService({
    agent: baseAgent("active"),
    drainResult: { drained: false, remainingCount: 3 },
  });

  const result = await service.transition(undefined, "tenant-1", "actor-1", "agent-1", "paused" as any, undefined, 1000);

  assert.equal(result.agent.lifecycleStatus, "paused", "the agent must still end up Paused even when the drain times out");
  assert.ok(result.warning, "a warning must be surfaced to the caller");
  assert.match(result.warning!, /3 in-flight operation/);

  assert.equal(transitionsRepository.records[0].warningFlag, true);
  assert.equal(transitionsRepository.records[0].incompleteOperationsCount, 3);
  assert.equal(audit.events[0].details.warningFlag, true);
  assert.equal(audit.events[0].details.incompleteOperationsCount, 3);
});

test("does not invoke the in-flight drain check for transitions other than Active->Paused", async () => {
  const { service, inFlight } = buildService({ agent: baseAgent("paused") });
  await service.transition(undefined, "tenant-1", "actor-1", "agent-1", "retired" as any, "done");
  assert.equal(inFlight.calls.length, 0);
});

test("uses the default 30-second drain timeout when none is provided", async () => {
  assert.equal(DEFAULT_PAUSE_DRAIN_TIMEOUT_MS, 30_000);
  const { service, inFlight } = buildService({ agent: baseAgent("active") });
  await service.transition(undefined, "tenant-1", "actor-1", "agent-1", "paused" as any, undefined);
  assert.equal(inFlight.calls[0].timeoutMs, 30_000);
});

test("throws 409 when the optimistic-lock compare-and-swap affects zero rows (concurrent modification)", async () => {
  const transitionsRepository = fakeTransitionsRepository();
  const audit = fakeAuditService();
  const inFlight = fakeInFlightOperations();
  const pubsub = fakePubSub();

  const racedRepository = {
    findOne: async () => baseAgent("active"),
    // Simulates another request having already changed the row between
    // this read and this write — the CAS legitimately matches nothing.
    compareAndSwapLifecycleStatus: async () => null,
  } as any;

  const service = new LifecycleService(racedRepository, transitionsRepository, audit, inFlight, pubsub);
  await assert.rejects(
    () => service.transition(undefined, "tenant-1", "actor-1", "agent-1", "paused" as any, undefined),
    (err: any) => {
      assert.equal(err.getStatus(), 409);
      assert.match(err.getResponse().message, /concurrently/);
      return true;
    },
  );
  assert.equal(transitionsRepository.records.length, 0, "no history record should be written for a failed CAS");
  assert.equal(audit.events.length, 0, "no audit event should be written for a failed CAS");
});

test("returns 404 when the agent does not exist", async () => {
  const repository = { findOne: async () => null } as any;
  const service = new LifecycleService(repository, fakeTransitionsRepository(), fakeAuditService(), fakeInFlightOperations(), fakePubSub());
  await assert.rejects(
    () => service.transition(undefined, "tenant-1", "actor-1", "missing-agent", "active" as any, undefined),
    (err: any) => {
      assert.equal(err.getStatus(), 404);
      return true;
    },
  );
});

test("publishes a best-effort real-time lifecycle event and does not let a publish failure fail the transition", async () => {
  const repository = fakeAgentsRepository(baseAgent("active"));
  const transitionsRepository = fakeTransitionsRepository();
  const audit = fakeAuditService();
  const inFlight = fakeInFlightOperations();
  const pubsub = { publish: async () => { throw new Error("redis unavailable"); } } as any;

  const service = new LifecycleService(repository, transitionsRepository, audit, inFlight, pubsub);
  const result = await service.transition(undefined, "tenant-1", "actor-1", "agent-1", "paused" as any, undefined);
  assert.equal(result.agent.lifecycleStatus, "paused", "a pub/sub publish failure must not fail the actual transition");
});

// WO-079: the Agent Registry page's real-time row updates reuse the
// existing /ws/health channel (HealthGateway) instead of a new gateway —
// a lifecycle transition must publish a shape-tagged message onto that
// same channel so useAgentHealthSocket can pick it out of the fleet-health
// snapshots HealthMetricsPublisherService also publishes there.
test("also publishes an agent_status_update message on the 'health' channel, for the Agent Registry page's real-time updates", async () => {
  const { service, pubsub } = buildService({ agent: baseAgent("active") });
  await service.transition(undefined, "tenant-1", "actor-1", "agent-1", "paused" as any, undefined);

  const healthMessages = pubsub.published.filter((p: any) => p.channel === "health");
  assert.equal(healthMessages.length, 1);
  assert.equal(healthMessages[0].tenantId, "tenant-1");
  assert.deepEqual(healthMessages[0].message.payload, {
    type: "agent_status_update",
    agentId: "agent-1",
    status: "paused",
    lastSeen: healthMessages[0].message.payload.lastSeen,
  });
  assert.ok(typeof healthMessages[0].message.payload.lastSeen === "string" && healthMessages[0].message.payload.lastSeen.length > 0);
});
