# Generic REST Adapter (WO-036)

The universal fallback for any agent that can make an HTTP call,
regardless of framework. See [TELEMETRY_PIPELINE.md](TELEMETRY_PIPELINE.md)
for the shared ingestion pipeline every framework adapter feeds into.

Registered under the framework_type `generic_rest` (the schema/DB enum
value established since WO-031/034) — this WO's own acceptance criteria
shorthand the endpoint as `/api/v1/adapters/rest/telemetry`; the actual
route is `/api/v1/adapters/generic_rest/telemetry`, same naming precedent
noted in WO-031's `create-agent.dto.ts`.

## Endpoint

```
POST /api/v1/adapters/generic_rest/telemetry
Content-Type: application/json
X-Agent-Id: <agent UUID>
X-Signature-256: <hex HMAC-SHA256 of the exact request body, using your agent's shared secret>
```

Accepts either a single event object or a JSON array of up to 100 events
(batch submission — every event is validated and published independently;
one invalid event in a batch never blocks the others). A batch response
reports `{ totalCount, acceptedCount, rejectedCount, results: [...] }`
where each result is `{ status: "accepted"|"rejected", result?, error? }`.
A single-event submission returns the pipeline result directly (no
wrapping): `{ accepted: true, eventId, dataClassification, deadLettered }`.

### Request body fields

| Field | Required | Notes |
|---|---|---|
| `agent_id` | yes | Must match the HMAC-authenticated agent (`X-Agent-Id`), or the event is rejected with 403. |
| `tenant_id` | yes | Must match that agent's tenant. |
| `event_type` | yes | One of `heartbeat`, `metric`, `trace`, `error`. |
| `event_id` | no | Defaults to a generated UUID. |
| `timestamp` | no | Defaults to the current time (ISO 8601). |
| `latency_ms` / `duration_ms` | no | `duration_ms` is a convenience alias; `latency_ms` wins if both are present. |
| `token_consumption` / `tokens` | no | `tokens` is a convenience alias. |
| `error_rate` | no | 0–1. |
| `tool_call_success` | no | boolean. |
| `tool_call_name` | no | string. |
| `adapter_version` | no | Defaults to this adapter's own version. |
| `raw_payload_hash` | no | Defaults to a SHA-256 hash computed over the submitted payload. |
| `metadata` | no | Free-form object — PHI-scrubbed by the shared pipeline before publication. Defaults to `{}`. |

No other fields are accepted (`additionalProperties: false`) — an
unrecognized field returns a 400 with the specific validation errors.

### curl

```bash
BODY='{"agent_id":"<agent-uuid>","tenant_id":"<tenant-uuid>","event_type":"metric","duration_ms":120,"tokens":300}'
SIGNATURE=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$HMAC_SECRET_HEX" | sed 's/^.* //')

curl -X POST https://api.yourplatform.com/api/v1/adapters/generic_rest/telemetry \
  -H "Content-Type: application/json" \
  -H "X-Agent-Id: <agent-uuid>" \
  -H "X-Signature-256: $SIGNATURE" \
  -d "$BODY"
```

### Python (`requests`)

```python
import hashlib
import hmac
import json
import requests

body = json.dumps({
    "agent_id": agent_id,
    "tenant_id": tenant_id,
    "event_type": "metric",
    "duration_ms": 120,
    "tokens": 300,
}).encode("utf-8")

signature = hmac.new(bytes.fromhex(hmac_secret_hex), body, hashlib.sha256).hexdigest()

requests.post(
    "https://api.yourplatform.com/api/v1/adapters/generic_rest/telemetry",
    data=body,
    headers={
        "Content-Type": "application/json",
        "X-Agent-Id": agent_id,
        "X-Signature-256": signature,
    },
)
```

### TypeScript (`fetch`)

```typescript
import { createHmac } from "node:crypto";

const body = JSON.stringify({
  agent_id: agentId,
  tenant_id: tenantId,
  event_type: "metric",
  duration_ms: 120,
  tokens: 300,
});
const signature = createHmac("sha256", Buffer.from(hmacSecretHex, "hex")).update(body).digest("hex");

await fetch("https://api.yourplatform.com/api/v1/adapters/generic_rest/telemetry", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-Agent-Id": agentId,
    "X-Signature-256": signature,
  },
  body,
});
```

### Batch example

```json
[
  { "agent_id": "...", "tenant_id": "...", "event_type": "heartbeat" },
  { "agent_id": "...", "tenant_id": "...", "event_type": "metric", "duration_ms": 88 }
]
```

## Connection validation & health probes

`RestConnectionValidator` sends `GET {health_endpoint}` (default expected
status 200, configurable via `expectedStatus`), following up to 3
redirects manually. 60s timeout for registration-time `validateConnection()`,
10s for ad-hoc `checkAgentHealth()`. An optional `apiKey` in
`connection_config` is sent as a Bearer token.
