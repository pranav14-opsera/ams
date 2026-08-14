import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { PG_POOL } from "../common/database/database.module";
import { AUDIT_SERVICE, type AuditServicePort } from "./ports/audit-service.port";
import { KMS_SERVICE, type KmsServicePort } from "./ports/kms-service.port";
import { RBAC_SERVICE, type RbacServicePort } from "./ports/rbac-service.port";
import { TenantRepository, type Tenant } from "./tenant.repository";

export class TenantAlreadyExistsError extends Error {
  constructor(slug: string) {
    super(`A tenant with slug "${slug}" already exists.`);
  }
}

export class TenantProvisioningError extends Error {
  constructor(
    message: string,
    public readonly correlationId: string,
    public readonly cause?: unknown,
  ) {
    super(message);
  }
}

export interface ProvisionTenantInput {
  name: string;
  slug: string;
  dataResidencyRegion: "us" | "eu";
  settings?: Record<string, unknown>;
  actorId: string | null;
}

// Orchestrates: create tenant row -> verify RLS is active for the new
// tenant -> provision a BYOK key reference -> apply default RBAC
// policies -> emit an audit event. Steps 1/3/4/5 are plain Postgres
// statements inside ONE transaction, so Postgres itself gives atomic
// rollback for them — no hand-rolled compensation needed. Step 2 (the
// KMS call) is the one genuinely external, non-transactional action:
// if it succeeds but a later step fails, the DB transaction still rolls
// back for free, but the KMS grant it created does not — that's the one
// place this saga needs an explicit compensating action.
@Injectable()
export class TenantProvisioningSaga {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly tenantRepository: TenantRepository,
    @Inject(KMS_SERVICE) private readonly kmsService: KmsServicePort,
    @Inject(RBAC_SERVICE) private readonly rbacService: RbacServicePort,
    @Inject(AUDIT_SERVICE) private readonly auditService: AuditServicePort,
  ) {}

  async provision(input: ProvisionTenantInput): Promise<Tenant> {
    const correlationId = randomUUID();
    const client = await this.pool.connect();
    let keyArn: string | undefined;

    try {
      await client.query("BEGIN");

      const existing = await this.tenantRepository.findBySlug(client, input.slug);
      if (existing) {
        await client.query("ROLLBACK");
        throw new TenantAlreadyExistsError(input.slug);
      }

      const tenant = await this.tenantRepository.create(client, {
        name: input.name,
        slug: input.slug,
        dataResidencyRegion: input.dataResidencyRegion,
        settings: input.settings ?? {},
      });

      await this.verifyRlsActive(client);

      // The one non-transactional step — everything before and after
      // this point is a plain SQL statement inside the still-open
      // transaction above.
      const kmsResult = await this.kmsService.createTenantKey(tenant.id, tenant.dataResidencyRegion);
      keyArn = kmsResult.keyArn;

      await this.tenantRepository.updateEncryptionKeyArn(client, tenant.id, keyArn);
      await this.rbacService.applyDefaultPolicies(tenant.id, client);
      await this.auditService.recordEvent(
        {
          tenantId: tenant.id,
          actorId: input.actorId,
          action: "tenant.provisioned",
          resourceType: "tenant",
          resourceId: tenant.id,
          details: { name: tenant.name, slug: tenant.slug, dataResidencyRegion: tenant.dataResidencyRegion, correlationId },
        },
        client,
      );

      await client.query("COMMIT");
      return { ...tenant, encryptionKeyArn: keyArn };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (keyArn) {
        // The DB rolled back for free; the KMS grant did not — undo it
        // explicitly so a failed provisioning attempt doesn't leak a key.
        await this.kmsService.deleteTenantKey(keyArn).catch(() => undefined);
      }
      if (err instanceof TenantAlreadyExistsError) {
        throw err;
      }
      throw new TenantProvisioningError("Tenant provisioning failed and was fully rolled back.", correlationId, err);
    } finally {
      client.release();
    }
  }

  // RLS itself is deployed once, generically, for every tenant at
  // migration time (enable_tenant_isolation() in
  // database/migrations/006_enable_rls.sql applies to the TABLE, not a
  // specific tenant) — there is no new per-tenant RLS policy to create.
  // This step exists so the saga has a real, verifiable checkpoint for
  // the acceptance criteria's "deploy RLS policies for the new tenant"
  // rather than silently assuming it's fine.
  private async verifyRlsActive(client: import("pg").PoolClient): Promise<void> {
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_policies WHERE tablename = 'agents' AND policyname = 'tenant_isolation'`,
    );
    if (result.rows[0]?.count === "0") {
      throw new Error("RLS tenant_isolation policy is not active — refusing to provision a tenant without it.");
    }
  }
}
