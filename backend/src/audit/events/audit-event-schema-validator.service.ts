import { Injectable } from "@nestjs/common";
import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import canonicalAuditEventSchema from "./canonical-audit-event.schema.json";

export interface AuditEventSchemaValidationResult {
  valid: boolean;
  errors: string[];
}

function formatError(error: ErrorObject): string {
  const path = error.instancePath || "(root)";
  return `${path} ${error.message ?? "is invalid"}`;
}

@Injectable()
export class AuditEventSchemaValidatorService {
  private readonly ajv = addFormats(new Ajv({ allErrors: true, strict: true }));
  private readonly validateFn = this.ajv.compile(canonicalAuditEventSchema);

  validate(payload: unknown): AuditEventSchemaValidationResult {
    const valid = this.validateFn(payload) as boolean;
    if (valid) return { valid: true, errors: [] };
    return { valid: false, errors: (this.validateFn.errors ?? []).map(formatError) };
  }
}
