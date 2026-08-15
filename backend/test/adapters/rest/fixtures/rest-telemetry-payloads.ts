import { randomUUID } from "node:crypto";

/** Realistic REST telemetry payloads: canonical field names, alias field names, single and batch formats, valid/invalid/PHI variants. */

export function canonicalNamedEvent(overrides: Record<string, unknown> = {}) {
  return {
    event_id: randomUUID(),
    agent_id: randomUUID(),
    tenant_id: randomUUID(),
    timestamp: new Date().toISOString(),
    event_type: "metric",
    latency_ms: 150,
    error_rate: 0,
    token_consumption: 300,
    tool_call_success: true,
    tool_call_name: "fetch_data",
    adapter_version: "1.0.0",
    metadata: {},
    ...overrides,
  };
}

export function aliasNamedEvent(overrides: Record<string, unknown> = {}) {
  return {
    agent_id: randomUUID(),
    tenant_id: randomUUID(),
    event_type: "metric",
    duration_ms: 90, // alias for latency_ms
    tokens: 50, // alias for token_consumption
    ...overrides,
  };
}

export const MINIMAL_VALID_EVENT = { agent_id: randomUUID(), tenant_id: randomUUID(), event_type: "heartbeat" };

export const INVALID_MISSING_AGENT_ID = { tenant_id: randomUUID(), event_type: "metric" };
export const INVALID_UNKNOWN_EVENT_TYPE = { agent_id: randomUUID(), tenant_id: randomUUID(), event_type: "not_a_real_type" };
export const INVALID_EXTRA_FIELD = { agent_id: randomUUID(), tenant_id: randomUUID(), event_type: "metric", unexpected_field: "nope" };

export const PHI_CONTAINING_EVENT = canonicalNamedEvent({ metadata: { patient_ssn: "999-88-7777" } });

export function batchOf(count: number): unknown[] {
  return Array.from({ length: count }, () => canonicalNamedEvent());
}
