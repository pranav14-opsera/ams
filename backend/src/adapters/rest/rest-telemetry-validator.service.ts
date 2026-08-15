import { Injectable } from "@nestjs/common";
import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import restTelemetryEventSchema from "./schemas/rest-telemetry-event.schema.json";

export interface RestSchemaValidationResult {
  valid: boolean;
  errors: string[];
}

function formatError(error: ErrorObject): string {
  const path = error.instancePath || "(root)";
  return `${path} ${error.message ?? "is invalid"}`;
}

/** Validates a raw REST telemetry submission against the looser, alias-friendly REST schema — distinct from TelemetrySchemaValidatorService, which validates the strict canonical shape AFTER translation. */
@Injectable()
export class RestTelemetryValidatorService {
  private readonly ajv = addFormats(new Ajv({ allErrors: true, strict: true }));
  private readonly validateFn = this.ajv.compile(restTelemetryEventSchema);

  validate(payload: unknown): RestSchemaValidationResult {
    const valid = this.validateFn(payload) as boolean;
    if (valid) return { valid: true, errors: [] };
    return { valid: false, errors: (this.validateFn.errors ?? []).map(formatError) };
  }
}
