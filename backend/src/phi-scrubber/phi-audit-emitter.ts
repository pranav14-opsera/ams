import { Inject, Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";
import type { DataClassification } from "../classification/data-classification.enum";
import { AUDIT_SERVICE, type AuditServicePort } from "../tenants/ports/audit-service.port";
import type { PhiDetection } from "./phi-scrubber.service";

/**
 * WO-043: "every PHI detection event must produce an immutable audit
 * record." Reuses the platform's own append-only, hash-chained
 * audit_events table (migration 005) rather than a bespoke PHI-specific
 * audit log — audit_events already guarantees exactly the immutability
 * property this WO asks for (REVOKE UPDATE/DELETE + trigger-computed hash
 * chain), and giving PHI detections their own resource_type ("telemetry_event")
 * and action ("phi_detected") keeps them queryable alongside every other
 * audit trail without inventing new infrastructure.
 */
@Injectable()
export class PhiAuditEmitter {
  constructor(@Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort) {}

  async recordDetections(
    client: PoolClient | undefined,
    tenantId: string,
    agentId: string,
    eventId: string,
    dataClassification: DataClassification,
    detections: PhiDetection[],
  ): Promise<void> {
    for (const detection of detections) {
      await this.auditService.recordEvent(
        {
          tenantId,
          actorId: null,
          action: "phi_detected",
          resourceType: "telemetry_event",
          resourceId: eventId,
          details: { agent_id: agentId, field_path: detection.fieldPath, reason: detection.reason, scrubbing_action: "masked" },
          dataClassification,
        },
        client,
      );
    }
  }
}
