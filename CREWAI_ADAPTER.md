# CrewAI Adapter (WO-037)

Translates CrewAI's hierarchical Crew → Task → Agent/Tool telemetry model
into the platform's canonical schema (WO-034). See
[TELEMETRY_PIPELINE.md](TELEMETRY_PIPELINE.md) for the shared ingestion
pipeline every framework adapter feeds into, and
[LANGCHAIN_ADAPTER.md](LANGCHAIN_ADAPTER.md) for the sibling adapter this
one's design closely follows (run/id correlation for latency, envelope
wrapping for tenant/agent identity).

## What it maps

| CrewAI event | Canonical `event_type` | Notes |
|---|---|---|
| `crew_kickoff` | `trace` | Records `crew_id` → timestamp so the matching `crew_completed` can compute latency. `parentEventId: null` (root of the hierarchy). |
| `crew_completed` | `metric` | `latency_ms` from the correlated `crew_kickoff`; `token_consumption` from `usage.total_tokens`. |
| `task_started` | `trace` | Records `task_id` → timestamp (independent of crew-level correlation). `parentEventId` = the task's `crew_id`. |
| `task_completed` | `metric` | `latency_ms` from the correlated `task_started`; `token_consumption` from `usage.total_tokens`. `parentEventId` = `crew_id`. |
| `task_failed` | `error` | `error_rate: 1`, message in `metadata.error` (PHI-scrubbed by the shared pipeline, not the adapter). |
| `agent_action` | `metric` | Uses its own `duration_ms` directly — a point-in-time action, no start/end pair to correlate. `parentEventId` = `task_id` (or `crew_id` if the action isn't task-scoped). |
| `tool_usage` | `metric` | Same latency handling as `agent_action`. `tool_call_success`/`tool_call_name` set directly from the event. |
| `delegation` | `trace` | `metadata` carries `delegationFrom`/`delegationTo`/`delegationReason` alongside the hierarchy. |

Every canonical event's `metadata` includes `{crewId, taskId, agentRole,
parentEventId}` — this is what reconstructs the workflow tree for
visualization: `crew_kickoff`/`crew_completed` are the root
(`parentEventId: null`); `task_started`/`task_completed`/`task_failed`
are one level below (`parentEventId` = their crew); `agent_action`/
`tool_usage`/`delegation` are one level below that (`parentEventId` =
their task, or the crew directly if not task-scoped).

`agent_id`/`tenant_id` aren't CrewAI concepts — same envelope-wrapping
approach as the LangChain adapter.

## Client-side integration guide

Instrument a CrewAI crew with a custom event emitter wired into CrewAI's
own `task_callback`/`step_callback` hooks (or an equivalent event bus,
depending on your CrewAI version) that POSTs each lifecycle event to this
endpoint.

```python
import hashlib
import hmac
import json
import time
import requests

class PlatformTelemetryEmitter:
    def __init__(self, endpoint_url, agent_id, tenant_id, hmac_secret_hex, adapter_version="1.0.0"):
        self.endpoint_url = endpoint_url
        self.agent_id = agent_id
        self.tenant_id = tenant_id
        self.hmac_secret = bytes.fromhex(hmac_secret_hex)
        self.adapter_version = adapter_version

    def emit(self, event: dict) -> None:
        envelope = {
            "agent_id": self.agent_id,
            "tenant_id": self.tenant_id,
            "adapter_version": self.adapter_version,
            "event": event,
        }
        body = json.dumps(envelope).encode("utf-8")
        signature = hmac.new(self.hmac_secret, body, hashlib.sha256).hexdigest()
        try:
            requests.post(
                self.endpoint_url,
                data=body,
                headers={
                    "Content-Type": "application/json",
                    "X-Agent-Id": self.agent_id,
                    "X-Signature-256": signature,
                },
                timeout=5,
            )
        except requests.RequestException:
            pass  # telemetry delivery is best-effort

    def now(self) -> str:
        return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())


telemetry = PlatformTelemetryEmitter(
    endpoint_url="https://api.yourplatform.com/api/v1/adapters/crewai/telemetry",
    agent_id=AGENT_ID,
    tenant_id=TENANT_ID,
    hmac_secret_hex=HMAC_SECRET_HEX,
)

# Crew lifecycle
telemetry.emit({"type": "crew_kickoff", "crew_id": crew_id, "timestamp": telemetry.now(), "crew_name": crew.name})
# ... crew.kickoff() ...
telemetry.emit({"type": "crew_completed", "crew_id": crew_id, "timestamp": telemetry.now(), "usage": {"total_tokens": crew.usage_metrics.total_tokens}})

# Per-task lifecycle (wire into your own task_callback)
def on_task_start(task):
    telemetry.emit({"type": "task_started", "crew_id": crew_id, "task_id": task.id, "agent_role": task.agent.role, "timestamp": telemetry.now(), "task_description": task.description})

def on_task_complete(task, output):
    telemetry.emit({"type": "task_completed", "crew_id": crew_id, "task_id": task.id, "agent_role": task.agent.role, "timestamp": telemetry.now(), "usage": {"total_tokens": task.output.token_usage.total_tokens}})

# Tool usage (wire into your agent's tool-call hook)
def on_tool_call(task_id, agent_role, tool_name, success, duration_ms):
    telemetry.emit({"type": "tool_usage", "crew_id": crew_id, "task_id": task_id, "agent_role": agent_role, "timestamp": telemetry.now(), "tool_name": tool_name, "success": success, "duration_ms": duration_ms})

# Delegation (when a manager/coordinator agent hands work to another agent)
def on_delegation(task_id, delegator_role, delegate_role, reason):
    telemetry.emit({"type": "delegation", "crew_id": crew_id, "task_id": task_id, "agent_role": delegator_role, "timestamp": telemetry.now(), "delegation_from": delegator_role, "delegation_to": delegate_role, "delegation_reason": reason})
```

## Connection validation & health probes

`CrewAiConnectionValidator` sends a `GET {crewConfigEndpoint}` request
and verifies the JSON response contains a `crew` key (60s timeout for
registration-time `validateConnection()`, 10s for
`checkAgentHealth()`). An optional `apiKey` in `connection_config` is
sent as a Bearer token.
