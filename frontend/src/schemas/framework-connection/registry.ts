import type { AgentFramework } from "@/types/dashboard";
import type { FrameworkConnectionSchema } from "./types";
import crewaiSchema from "./crewai.schema.json";
import langchainSchema from "./langchain.schema.json";
import restSchema from "./rest.schema.json";

/**
 * The pluggable schema registry the WO's own description calls for:
 * "new adapters can be added by defining a schema rather than writing new
 * form code." Phase 2 (autogen) simply has no entry yet — resolveSchema
 * below treats that as the same "unregistered framework" case a genuinely
 * unknown value would hit, exercised by the crewai placeholder entry
 * already present here (registered, but not yet selectable in Step 1 —
 * see frameworks.ts's own `available: false`).
 */
const SCHEMA_REGISTRY: Partial<Record<AgentFramework, FrameworkConnectionSchema>> = {
  langchain: langchainSchema as FrameworkConnectionSchema,
  generic_rest: restSchema as FrameworkConnectionSchema,
  crewai: crewaiSchema as FrameworkConnectionSchema,
};

export function resolveFrameworkSchema(framework: AgentFramework): FrameworkConnectionSchema | null {
  return SCHEMA_REGISTRY[framework] ?? null;
}

/** Every field name a framework's schema defines, sorted by its own `x-order` — the canonical field render order. */
export function orderedFieldNames(schema: FrameworkConnectionSchema): string[] {
  return Object.keys(schema.properties).sort((a, b) => schema.properties[a]!["x-order"] - schema.properties[b]!["x-order"]);
}
