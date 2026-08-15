import { Injectable } from "@nestjs/common";
import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import canonicalTelemetrySchema from "./schemas/canonical-telemetry.schema.json";

export interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
}

function formatError(error: ErrorObject): string {
  const path = error.instancePath || "(root)";
  return `${path} ${error.message ?? "is invalid"}`;
}

@Injectable()
export class TelemetrySchemaValidatorService {
  private readonly ajv = addFormats(new Ajv({ allErrors: true, strict: true }));
  private readonly validateFn = this.ajv.compile(canonicalTelemetrySchema);

  validate(payload: unknown): SchemaValidationResult {
    const valid = this.validateFn(payload) as boolean;
    if (valid) return { valid: true, errors: [] };
    return { valid: false, errors: (this.validateFn.errors ?? []).map(formatError) };
  }
}
