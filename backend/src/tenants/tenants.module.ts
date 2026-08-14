import { Module } from "@nestjs/common";
import { EncryptionModule } from "../encryption/encryption.module";
import { AUDIT_SERVICE } from "./ports/audit-service.port";
import { PostgresAuditService } from "./ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "./ports/postgres/postgres-rbac.service";
import { RBAC_SERVICE } from "./ports/rbac-service.port";
import { TenantProvisioningSaga } from "./tenant-provisioning.saga";
import { TenantRepository } from "./tenant.repository";
import { TenantsController } from "./tenants.controller";
import { TenantsService } from "./tenants.service";

@Module({
  // KMS_SERVICE (and the mock-vs-real adapter switch) now lives in
  // EncryptionModule (WO-015) — the saga consumes it from there rather
  // than TenantsModule providing its own copy.
  imports: [EncryptionModule],
  controllers: [TenantsController],
  providers: [
    TenantsService,
    TenantProvisioningSaga,
    TenantRepository,
    // audit_events and rbac_policies are real tables in this same
    // database today — real implementations, not stubs.
    { provide: AUDIT_SERVICE, useClass: PostgresAuditService },
    { provide: RBAC_SERVICE, useClass: PostgresRbacService },
  ],
  exports: [TenantsService, TenantRepository],
})
export class TenantsModule {}
