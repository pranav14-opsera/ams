/**
 * WO-080: a deliberately small SUBSET of JSON Schema (draft-07-shaped —
 * `type`/`properties`/`required`/`enum`/`format`/`pattern`) plus a handful
 * of `x-`-prefixed extension keywords (the same escape hatch JSON Schema
 * itself reserves for vendor extensions) that this WO's own
 * SchemaFormRenderer needs to pick a concrete form widget and render
 * order/help text — real JSON Schema tooling ignores unknown `x-*`
 * keywords rather than erroring on them, so these schema documents remain
 * valid, portable JSON Schema even though only this codebase's renderer
 * understands the widget hints.
 *
 * This is the whole point of the "pluggable JSON schema pattern" the
 * WO's own description calls for: Phase 2 (CrewAI/AutoGen) support is
 * just a new schema file satisfying this same shape, registered in
 * `registry.ts` — no change to SchemaFormRenderer, MultiStepWizard, or
 * any other wizard shell code.
 */

export type FrameworkFieldWidget = "text" | "password" | "url" | "select" | "checkbox" | "keyvalue";

export interface FrameworkSchemaProperty {
  type: "string" | "boolean" | "array";
  title: string;
  description?: string;
  format?: "uri" | "password";
  /** Present only for a "select" widget. */
  enum?: string[];
  /** Validated client-side with `new RegExp(pattern)` — e.g. REST's `healthCheckEndpoint` must start with "/". */
  pattern?: string;
  /** Only for `x-widget: "keyvalue"` (an array of {key, value} objects) — REST's optional custom headers. */
  items?: { type: "object"; properties: { key: { type: "string" }; value: { type: "string" } }; required: string[] };
  "x-order": number;
  "x-widget": FrameworkFieldWidget;
}

export interface FrameworkConnectionSchema {
  $id: string;
  title: string;
  description?: string;
  type: "object";
  properties: Record<string, FrameworkSchemaProperty>;
  required: string[];
}
