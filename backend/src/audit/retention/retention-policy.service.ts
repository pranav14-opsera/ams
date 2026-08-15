import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import type { PoolClient } from "pg";
import { DataClassification } from "../../classification/data-classification.enum";
import { AUDIT_SERVICE, type AuditServicePort } from "../../tenants/ports/audit-service.port";
import type { RetentionPolicy } from "./retention-policy.repository";
import { RetentionPolicyRepository } from "./retention-policy.repository";
import type { DataCategory } from "./retention-policy.constants";
import { DATA_CATEGORIES, RETENTION_BOUNDS, RETENTION_SHORTENING_GRACE_PERIOD_DAYS } from "./retention-policy.constants";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * WO-049's retention policy configuration layer. Enforces the AC's
 * per-category min/max bounds and the 30-day grace period on retention
 * SHORTENING (a lengthening takes effect immediately — there is no data at
 * risk of premature purge in that direction).
 */
@Injectable()
export class RetentionPolicyService {
  constructor(
    private readonly repository: RetentionPolicyRepository,
    @Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort,
  ) {}

  async list(tenantId: string, client?: PoolClient): Promise<RetentionPolicy[]> {
    const configured = await this.repository.findByTenant(tenantId, client);
    const byCategory = new Map(configured.map((p) => [p.dataCategory, p]));
    // Every category is always represented, even if the tenant never
    // configured one — with the platform default, not silently omitted.
    return DATA_CATEGORIES.map(
      (category) =>
        byCategory.get(category) ?? {
          tenantId,
          dataCategory: category,
          retentionDays: RETENTION_BOUNDS[category].defaultDays,
          previousRetentionDays: null,
          policyChangedAt: null,
          updatedBy: null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
    );
  }

  async upsert(tenantId: string, dataCategory: DataCategory, retentionDays: number, updatedBy: string | null, client?: PoolClient): Promise<RetentionPolicy> {
    const bounds = RETENTION_BOUNDS[dataCategory];
    if (retentionDays < bounds.minDays || retentionDays > bounds.maxDays) {
      throw new BadRequestException(`retentionDays for ${dataCategory} must be between ${bounds.minDays} and ${bounds.maxDays} (got ${retentionDays})`);
    }
    const before = await this.repository.findOne(tenantId, dataCategory, client);
    const policy = await this.repository.upsert({ tenantId, dataCategory, retentionDays, updatedBy }, client);

    if (before?.retentionDays !== retentionDays) {
      await this.auditService.recordEvent(
        {
          tenantId,
          actorId: updatedBy,
          action: "retention.policy_changed",
          resourceType: "retention_policy",
          resourceId: tenantId,
          details: { dataCategory, previousRetentionDays: before?.retentionDays ?? null, newRetentionDays: retentionDays },
          dataClassification: DataClassification.CONFIDENTIAL,
        },
        client,
      );
    }

    return policy;
  }

  /** The retention period actually in force right now for this policy — honors the 30-day grace period on a shortening (the OLD, longer value still applies until the grace period elapses). */
  effectiveRetentionDays(policy: RetentionPolicy): number {
    if (policy.previousRetentionDays === null || policy.policyChangedAt === null) return policy.retentionDays;
    if (policy.retentionDays >= policy.previousRetentionDays) return policy.retentionDays; // a lengthening applies immediately

    const graceElapsed = Date.now() - policy.policyChangedAt.getTime() >= RETENTION_SHORTENING_GRACE_PERIOD_DAYS * DAY_MS;
    return graceElapsed ? policy.retentionDays : policy.previousRetentionDays;
  }
}
