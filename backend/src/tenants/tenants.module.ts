import { Module } from "@nestjs/common";
import { AUDIT_SERVICE } from "./ports/audit-service.port";
import { KMS_SERVICE } from "./ports/kms-service.port";
import { InMemoryKmsService } from "./ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "./ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "./ports/postgres/postgres-rbac.service";
import { RBAC_SERVICE } from "./ports/rbac-service.port";
import { TenantProvisioningSaga } from "./tenant-provisioning.saga";
import { TenantRepository } from "./tenant.repository";
import { TenantsController } from "./tenants.controller";
import { TenantsService } from "./tenants.service";

@Module({
  controllers: [TenantsController],
  providers: [
    TenantsService,
    TenantProvisioningSaga,
    TenantRepository,
    // audit_events and rbac_policies are real tables in this same
    // database today — real implementations, not stubs. KMS is
    // genuinely external and not yet built (WO-015's scope), so it
    // stays an in-memory stand-in until that lands.
    { provide: AUDIT_SERVICE, useClass: PostgresAuditService },
    { provide: RBAC_SERVICE, useClass: PostgresRbacService },
    { provide: KMS_SERVICE, useClass: InMemoryKmsService },
  ],
  exports: [TenantsService, TenantRepository],
})
export class TenantsModule {}
