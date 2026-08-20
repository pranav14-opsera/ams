import type { FrameworkConnectionSchema, FrameworkSchemaProperty } from "@/schemas/framework-connection/types";

function isUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** AC: "real-time field validation" — required, URL format, and custom `pattern` rules per schema. Returns an error message, or null when the value is valid. */
export function validateFieldValue(property: FrameworkSchemaProperty, required: boolean, value: unknown): string | null {
  const isEmpty = value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);

  if (required && isEmpty) return `${property.title} is required.`;
  if (isEmpty) return null; // Optional and empty — nothing further to check.

  if (property.format === "uri" && typeof value === "string" && !isUrl(value)) {
    return `${property.title} must be a valid URL (e.g. https://example.com).`;
  }
  if (property.pattern && typeof value === "string" && !new RegExp(property.pattern).test(value)) {
    return property["x-widget"] === "text" && property.pattern === "^/" ? `${property.title} must start with "/" (e.g. /health).` : `${property.title} does not match the required format.`;
  }
  if (property.enum && typeof value === "string" && value.length > 0 && !property.enum.includes(value)) {
    return `${property.title} must be one of: ${property.enum.join(", ")}.`;
  }

  return null;
}

/** Validates every field in a schema against the current wizard field values — the Step 2 "next" gate and the Step 4 pre-submit re-check. */
export function validateSchemaValues(schema: FrameworkConnectionSchema, values: Record<string, unknown>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const [name, property] of Object.entries(schema.properties)) {
    const error = validateFieldValue(property, schema.required.includes(name), values[name]);
    if (error) errors[name] = error;
  }
  return errors;
}

export function isSchemaValid(schema: FrameworkConnectionSchema, values: Record<string, unknown>): boolean {
  return Object.keys(validateSchemaValues(schema, values)).length === 0;
}
