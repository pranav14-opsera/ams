import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "../../common/database/database.module";
import { TenantRepository } from "../../tenants/tenant.repository";
import { ActorType, type CanonicalAuditEvent } from "./canonical-audit-event";

const VALID_CLASSIFICATIONS = new Set(["public", "internal", "confidential", "restricted"]);
/** Defense-in-depth default (WO-043's own precedent): an event with a missing or invalid classification gets the STRICTEST tier, never the loosest. */
const DEFAULT_CLASSIFICATION = "restricted";

export class TenantValidationError extends Error {
  constructor(tenantId: string) {
    super(`Audit event references unknown tenant_id "${tenantId}" — cannot enrich or persist.`);
    this.name = "TenantValidationError";
  }
}

export interface EnrichedAuditEvent extends CanonicalAuditEvent {
  /** Server-side timestamp, set at enrichment time — distinct from the producer-supplied occurred_at (see AUDIT_ENRICHMENT_PIPELINE.md). */
  enriched_at: string;
  /** True only when actor_type is "user" and actor_id resolved to a real, still-active row in `users` at enrichment time. False for every other actor_type (system/service_account/api_key have no `users` row to resolve) or when resolution failed. */
  actor_resolved: boolean;
}

/**
 * WO-046: validates tenant_id genuinely exists (never enrich/persist an
 * event for an unknown tenant — a forged or buggy producer's mistake
 * must not corrupt another tenant's chain or land in a partition with
 * no real tenant behind it), best-effort resolves user actor identity,
 * and validates/defaults data_classification. Does NOT do PHI scrubbing
 * — that's AuditEventConsumerPipelineService's own next stage, reusing
 * WO-017/043's PhiScrubberService exactly as TelemetryPipelineService
 * does, rather than duplicating scrubbing logic here.
 */
@Injectable()
export class AuditEnrichmentService {
  private readonly logger = new Logger(AuditEnrichmentService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly tenantRepository: TenantRepository,
  ) {}

  async enrich(event: CanonicalAuditEvent, client?: Pool | PoolClient): Promise<EnrichedAuditEvent> {
    const executor = client ?? this.pool;

    const tenant = await this.tenantRepository.findById(executor, event.tenant_id);
    if (!tenant) {
      throw new TenantValidationError(event.tenant_id);
    }

    let actorResolved = false;
    if (event.actor_type === ActorType.USER && event.actor_id) {
      try {
        const result = await executor.query("SELECT 1 FROM users WHERE id = $1 AND tenant_id = $2", [event.actor_id, event.tenant_id]);
        actorResolved = (result.rowCount ?? 0) > 0;
        if (!actorResolved) {
          this.logger.warn(`audit event ${event.event_id}: actor_id "${event.actor_id}" claims actor_type=user but no matching user row was found for tenant ${event.tenant_id} — proceeding, actor identity unresolved.`);
        }
      } catch (err) {
        this.logger.warn(`audit event ${event.event_id}: actor resolution query failed, proceeding with actor_resolved=false: ${err instanceof Error ? err.message : err}`);
      }
    }

    const dataClassification = event.data_classification && VALID_CLASSIFICATIONS.has(event.data_classification) ? event.data_classification : DEFAULT_CLASSIFICATION;
    if (event.data_classification && !VALID_CLASSIFICATIONS.has(event.data_classification)) {
      this.logger.warn(`audit event ${event.event_id}: data_classification "${event.data_classification}" is not a recognized tier — defaulting to "${DEFAULT_CLASSIFICATION}".`);
    }

    return {
      ...event,
      data_classification: dataClassification,
      enriched_at: new Date().toISOString(),
      actor_resolved: actorResolved,
    };
  }
}
