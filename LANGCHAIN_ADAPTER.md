# LangChain Adapter (WO-035)

Translates LangChain's callback-based telemetry model into the platform's
canonical telemetry schema (WO-034). See [TELEMETRY_PIPELINE.md](TELEMETRY_PIPELINE.md)
for the shared ingestion pipeline every framework adapter feeds into.

## What it maps

| LangChain callback | Canonical `event_type` | Notes |
|---|---|---|
| `on_llm_start` / `on_tool_start` / `on_chain_start` / `on_retriever_start` | `trace` | `latency_ms: null` — the operation hasn't completed yet. Its `run_id`+timestamp is recorded so the matching `_end`/`_error` can compute latency. |
| `on_llm_end` / `on_tool_end` / `on_chain_end` / `on_retriever_end` | `metric` | `latency_ms` = end timestamp − the correlated `_start` timestamp (`null` if no matching start was ever seen). `on_llm_end` also extracts `token_consumption` (prefers the newer `usage_metadata.total_tokens`, falls back to legacy `llm_output.token_usage.total_tokens`, then `null`). `on_tool_end` sets `tool_call_success: true`. |
| `on_llm_error` / `on_tool_error` / `on_chain_error` | `error` | `error_rate: 1`, error message carried in `metadata.error` — PHI-scrubbed by the shared pipeline before publication, not by the adapter itself. |

`agent_id`/`tenant_id` aren't LangChain concepts — the client SDK below
wraps each raw callback event in an envelope carrying them, which is
what `LangChainAdapter.translateTelemetry()` actually receives.

## Client-side SDK snippet

Runs in the **user's own LangChain application** (a separate codebase
from this platform's backend — install the real `langchain`/`langchain-core`
package there, not here) and installs as a standard `BaseCallbackHandler`.

### TypeScript

```typescript
import { createHmac, randomBytes } from "node:crypto";
import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";

interface PlatformTelemetryConfig {
  endpointUrl: string; // e.g. https://api.yourplatform.com/api/v1/adapters/langchain/telemetry
  agentId: string;
  tenantId: string;
  hmacSecretHex: string; // revealed once, at agent registration — store it securely
  adapterVersion: string;
}

export class PlatformTelemetryHandler implements Partial<BaseCallbackHandler> {
  constructor(private readonly config: PlatformTelemetryConfig) {}

  private async send(event: Record<string, unknown>): Promise<void> {
    const envelope = {
      agent_id: this.config.agentId,
      tenant_id: this.config.tenantId,
      adapter_version: this.config.adapterVersion,
      event,
    };
    const body = JSON.stringify(envelope);
    const signature = createHmac("sha256", Buffer.from(this.config.hmacSecretHex, "hex")).update(body).digest("hex");

    await fetch(this.config.endpointUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agent-Id": this.config.agentId,
        "X-Signature-256": signature,
      },
      body,
    }).catch(() => undefined); // telemetry delivery is best-effort — never let it break the agent's own request
  }

  async handleLLMStart(llm: { name?: string }, prompts: string[], runId: string): Promise<void> {
    await this.send({ type: "on_llm_start", run_id: runId, timestamp: new Date().toISOString(), serialized: { name: llm.name }, prompts });
  }

  async handleLLMEnd(output: unknown, runId: string): Promise<void> {
    await this.send({ type: "on_llm_end", run_id: runId, timestamp: new Date().toISOString(), response: output });
  }

  async handleLLMError(err: Error, runId: string): Promise<void> {
    await this.send({ type: "on_llm_error", run_id: runId, timestamp: new Date().toISOString(), error: { message: err.message, name: err.name } });
  }

  // handleToolStart/End/Error, handleChainStart/End/Error, and
  // handleRetrieverStart/End follow the identical pattern — see
  // backend/test/adapters/langchain/fixtures/langchain-callback-payloads.ts
  // in this platform's own repo for the exact payload shape each expects.
}
```

Usage:

```typescript
const handler = new PlatformTelemetryHandler({
  endpointUrl: "https://api.yourplatform.com/api/v1/adapters/langchain/telemetry",
  agentId: "...",
  tenantId: "...",
  hmacSecretHex: process.env.PLATFORM_HMAC_SECRET!,
  adapterVersion: "1.0.0",
});

const chain = new AgentExecutor({ /* ... */ }).withConfig({ callbacks: [handler] });
```

### Python

```python
import hashlib
import hmac
import json
import time
from datetime import datetime, timezone

import requests
from langchain_core.callbacks import BaseCallbackHandler


class PlatformTelemetryHandler(BaseCallbackHandler):
    def __init__(self, endpoint_url: str, agent_id: str, tenant_id: str, hmac_secret_hex: str, adapter_version: str):
        self.endpoint_url = endpoint_url
        self.agent_id = agent_id
        self.tenant_id = tenant_id
        self.hmac_secret = bytes.fromhex(hmac_secret_hex)
        self.adapter_version = adapter_version

    def _send(self, event: dict) -> None:
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

    def on_llm_start(self, serialized, prompts, *, run_id, **kwargs):
        self._send({
            "type": "on_llm_start",
            "run_id": str(run_id),
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "serialized": {"name": serialized.get("name")},
            "prompts": prompts,
        })

    def on_llm_end(self, response, *, run_id, **kwargs):
        self._send({
            "type": "on_llm_end",
            "run_id": str(run_id),
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "response": response.dict() if hasattr(response, "dict") else response,
        })

    def on_llm_error(self, error, *, run_id, **kwargs):
        self._send({
            "type": "on_llm_error",
            "run_id": str(run_id),
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "error": {"message": str(error), "name": type(error).__name__},
        })

    # on_tool_start/end/error, on_chain_start/end/error, and
    # on_retriever_start/end follow the identical pattern.
```

## Connection validation & health probes

`LangChainConnectionValidator` sends a `GET {endpointUrl}/health` request
(60s timeout for registration-time `validateConnection()`, 10s for
`checkAgentHealth()`) — the agent's `connection_config` must include an
`endpointUrl`, with an optional `apiKey` sent as a Bearer token.

`checkAgentHealth(config)` exists on `LangChainAdapter` itself (not on
`IAgentAdapter`) since that interface's `getHealthProbe()` takes no
per-agent config — `AdapterRegistryService` holds one adapter instance
per framework type, shared across every agent of that type.
