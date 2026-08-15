import { randomUUID } from "node:crypto";
import { TelemetryEventType, type CanonicalTelemetryEvent } from "../../src/adapters/schemas/canonical-telemetry";

export interface SyntheticEventGeneratorConfig {
  eventsPerSecond: number;
  durationSeconds: number;
  numTenants: number;
  numAgentsPerTenant: number;
  /** 0-1, share of events shaped as LangChain envelopes vs. generic_rest. */
  frameworkDistribution: { langchain: number; genericRest: number };
  errorRate: number;
}

export interface SyntheticTenantAgent {
  tenantId: string;
  agentId: string;
}

/** Deterministic per-run tenant/agent pool — callers provision real tenants/agents against these IDs before generating events. */
export function buildTenantAgentPool(config: Pick<SyntheticEventGeneratorConfig, "numTenants" | "numAgentsPerTenant">): SyntheticTenantAgent[][] {
  const pool: SyntheticTenantAgent[][] = [];
  for (let t = 0; t < config.numTenants; t++) {
    const tenantId = randomUUID();
    const agents: SyntheticTenantAgent[] = [];
    for (let a = 0; a < config.numAgentsPerTenant; a++) {
      agents.push({ tenantId, agentId: randomUUID() });
    }
    pool.push(agents);
  }
  return pool;
}

function pickFramework(frameworkDistribution: SyntheticEventGeneratorConfig["frameworkDistribution"], rand: number): "langchain" | "generic_rest" {
  return rand < frameworkDistribution.langchain ? "langchain" : "generic_rest";
}

/**
 * WO-044: produces a realistically-shaped CanonicalTelemetryEvent per
 * call — the SAME schema every real adapter translates into (WO-034's
 * canonical-telemetry.ts), not a framework-native raw payload, since the
 * load test drives TelemetryPipelineService.process() directly rather
 * than going through a specific adapter's translateTelemetry(). Each
 * event carries a `generatedAtMs` field in metadata for end-to-end
 * latency measurement by the harness.
 */
export function generateSyntheticEvent(pool: SyntheticTenantAgent[], config: SyntheticEventGeneratorConfig): CanonicalTelemetryEvent {
  const target = pool[Math.floor(Math.random() * pool.length)];
  const framework = pickFramework(config.frameworkDistribution, Math.random());
  const isError = Math.random() < config.errorRate;

  return {
    event_id: randomUUID(),
    agent_id: target.agentId,
    tenant_id: target.tenantId,
    timestamp: new Date().toISOString(),
    event_type: isError ? TelemetryEventType.ERROR : TelemetryEventType.TRACE,
    latency_ms: isError ? null : Math.round(40 + Math.random() * 400),
    error_rate: isError ? 1 : 0,
    token_consumption: Math.round(50 + Math.random() * 900),
    tool_call_success: isError ? false : Math.random() > 0.05,
    tool_call_name: framework === "langchain" ? "llm_chain_call" : "rest_invoke",
    framework_type: framework,
    adapter_version: "load-test-1.0.0",
    raw_payload_hash: "b".repeat(64),
    metadata: { generatedAtMs: Date.now(), synthetic: true, framework },
  };
}

/** Generates `count` events immediately (no pacing) — used by unit tests validating shape/throughput accuracy, and by the harness's own internal batching. */
export function generateBatch(pool: SyntheticTenantAgent[], config: SyntheticEventGeneratorConfig, count: number): CanonicalTelemetryEvent[] {
  return Array.from({ length: count }, () => generateSyntheticEvent(pool, config));
}
