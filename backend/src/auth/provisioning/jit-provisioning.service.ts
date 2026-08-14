import { ForbiddenException, Inject, Injectable, Logger } from "@nestjs/common";
import type { Pool } from "pg";
import { PG_POOL } from "../../common/database/database.module";
import { DataClassification } from "../../classification/data-classification.enum";
import { AUDIT_SERVICE, type AuditServicePort } from "../../tenants/ports/audit-service.port";
import { GroupRoleMappingRepository, type PlatformRole } from "./group-role-mapping.repository";

interface UserRow {
  id: string;
  status: string;
  provisioned_via: string;
  role: PlatformRole | null;
}

export interface JitProvisioningResult {
  userId: string;
  role: PlatformRole | null;
}

@Injectable()
export class JitProvisioningService {
  private readonly logger = new Logger(JitProvisioningService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly groupRoleMappingRepository: GroupRoleMappingRepository,
    @Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort,
  ) {}

  /**
   * idp_subject match first (already-linked user), else email (first SSO
   * login for a pre-provisioned or previously-manual user, backfilling
   * idp_subject), else creates a brand-new user row. In every case the
   * platform role is re-resolved from the CURRENT group claims on this
   * login — a user's role tracks their IdP group membership, it isn't
   * fixed at first provisioning.
   */
  async provisionOrUpdate(tenantId: string, idpSubject: string, email: string | null, displayName: string | null, groups: string[]): Promise<JitProvisioningResult> {
    const resolvedRole = await this.groupRoleMappingRepository.resolveRole(this.pool, tenantId, groups);
    if (resolvedRole === null) {
      // resourceId must be a real UUID (the audit_events column type) —
      // idpSubject is arbitrary IdP-supplied text (an email, a SAML
      // NameID, anything), not necessarily a UUID, so it goes in
      // `details` instead. The resource this event is really about is
      // the tenant-level provisioning decision, not a (not yet
      // necessarily existing) user row.
      await this.auditService.recordEvent({
        tenantId,
        actorId: null,
        action: "auth.jit.no_role_matched",
        resourceType: "user",
        resourceId: tenantId,
        details: { idpSubject, groups },
        dataClassification: DataClassification.INTERNAL,
      });
    }

    const bySubject = await this.pool.query<UserRow>("SELECT id, status, provisioned_via, role FROM users WHERE tenant_id = $1 AND idp_subject = $2", [
      tenantId,
      idpSubject,
    ]);
    if (bySubject.rows[0]) {
      return this.applyRole(tenantId, bySubject.rows[0], resolvedRole);
    }

    if (email) {
      const byEmail = await this.pool.query<UserRow>("SELECT id, status, provisioned_via, role FROM users WHERE tenant_id = $1 AND email = $2", [
        tenantId,
        email,
      ]);
      if (byEmail.rows[0]) {
        this.enforceScimGuard(byEmail.rows[0]);
        await this.pool.query("UPDATE users SET idp_subject = $1, last_login_at = now() WHERE id = $2", [idpSubject, byEmail.rows[0].id]);
        return this.applyRole(tenantId, byEmail.rows[0], resolvedRole);
      }
    }

    if (!email) {
      throw new ForbiddenException("Cannot JIT-provision a new user without an email claim.");
    }

    const inserted = await this.pool.query<UserRow>(
      `INSERT INTO users (tenant_id, email, display_name, idp_subject, role, provisioned_via, last_login_at)
       VALUES ($1, $2, $3, $4, $5, 'jit', now())
       ON CONFLICT (tenant_id, email) DO NOTHING
       RETURNING id, status, provisioned_via, role`,
      [tenantId, email, displayName ?? email, idpSubject, resolvedRole],
    );

    if (inserted.rows[0]) {
      await this.auditService.recordEvent({
        tenantId,
        actorId: inserted.rows[0].id,
        action: "auth.jit.user_created",
        resourceType: "user",
        resourceId: inserted.rows[0].id,
        details: { groups, role: resolvedRole },
        dataClassification: DataClassification.INTERNAL,
      });
      return { userId: inserted.rows[0].id, role: resolvedRole };
    }

    // Lost the ON CONFLICT race to a concurrent request for the same
    // email — re-select the canonical row another request just created.
    const raced = await this.pool.query<UserRow>("SELECT id, status, provisioned_via, role FROM users WHERE tenant_id = $1 AND email = $2", [tenantId, email]);
    this.enforceScimGuard(raced.rows[0]);
    await this.pool.query("UPDATE users SET idp_subject = $1, last_login_at = now() WHERE id = $2", [idpSubject, raced.rows[0].id]);
    return this.applyRole(tenantId, raced.rows[0], resolvedRole);
  }

  private enforceScimGuard(user: UserRow): void {
    if (user.provisioned_via === "scim" && user.status === "deactivated") {
      throw new ForbiddenException("This account was deprovisioned via SCIM and cannot be reactivated by SSO login.");
    }
  }

  private async applyRole(tenantId: string, user: UserRow, resolvedRole: PlatformRole | null): Promise<JitProvisioningResult> {
    this.enforceScimGuard(user);
    if (user.role !== resolvedRole) {
      await this.pool.query("UPDATE users SET role = $1, last_login_at = now() WHERE id = $2", [resolvedRole, user.id]);
      this.logger.log(`Role re-resolved for user ${user.id} (tenant=${tenantId}): ${user.role ?? "none"} -> ${resolvedRole ?? "none"}`);
    } else {
      await this.pool.query("UPDATE users SET last_login_at = now() WHERE id = $1", [user.id]);
    }
    return { userId: user.id, role: resolvedRole };
  }
}
