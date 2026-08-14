import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { Pool } from "pg";
import { PG_POOL } from "../../common/database/database.module";
import { DataClassification } from "../../classification/data-classification.enum";
import { SESSION_STORE, type SessionStorePort } from "../session/session-store.port";
import { CLASSIFICATION_METADATA_KEY } from "./requires-classification.decorator";
import { DEFAULT_MFA_POLICY, TenantMfaPolicyRepository } from "./tenant-mfa-policy.repository";

// Reads the @RequiresClassification() metadata a route declares and
// enforces MFA elevation before allowing the request through. This is
// deliberately standalone rather than folded into RBAC middleware
// (mentioned in this WO's description as WO-024's integration point,
// which doesn't exist yet) — the classification-driven step-up check is
// a complete, independently testable unit regardless of what enforces
// permissions on top of it later.
@Injectable()
export class MfaStepUpGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(SESSION_STORE) private readonly sessionStore: SessionStorePort,
    private readonly policyRepository: TenantMfaPolicyRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const tier = this.reflector.get<DataClassification | undefined>(CLASSIFICATION_METADATA_KEY, context.getHandler());
    if (!tier) return true; // route doesn't declare a classification — no step-up gate applies

    const req = context.switchToHttp().getRequest<Request>();
    const policy = (req.tenantId && (await this.policyRepository.findByTenantId(this.pool, req.tenantId))) || { tenantId: req.tenantId ?? "", ...DEFAULT_MFA_POLICY };

    if (tier === DataClassification.PUBLIC && !policy.requireMfaForPublic) return true;
    if (tier === DataClassification.INTERNAL && !policy.requireMfaForInternal) return true;

    if (!req.sessionId) {
      this.denyStepUp(tier);
    }

    const session = await this.sessionStore.get(req.sessionId!);
    if (!session || !session.mfaElevated || !session.mfaElevatedAt) {
      this.denyStepUp(tier);
    }

    if (tier === DataClassification.RESTRICTED) {
      const elevationAgeMinutes = (Date.now() - session!.mfaElevatedAt!.getTime()) / 60_000;
      if (elevationAgeMinutes > policy.restrictedElevationMinutes) {
        this.denyStepUp(tier);
      }
    }
    // CONFIDENTIAL (and INTERNAL/PUBLIC when policy requires it): no
    // duration check beyond mfaElevated being true at all — "session-
    // lifetime" elevation, per this WO's own acceptance criteria.

    return true;
  }

  private denyStepUp(tier: DataClassification): never {
    throw new ForbiddenException({
      error: "MFA_REQUIRED",
      message: `MFA verification is required to access ${tier}-tier data.`,
      classification: tier,
      stepUpUrl: "/api/v1/auth/mfa/verify",
    });
  }
}
