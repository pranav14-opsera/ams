import { Module } from "@nestjs/common";
import { KMS_SERVICE } from "../tenants/ports/kms-service.port";
import { InMemoryKmsService } from "../tenants/ports/in-memory/in-memory-kms.service";
import { TenantKeyMetadataRepository } from "../tenants/tenant-key-metadata.repository";
import { AUDIT_SERVICE } from "../tenants/ports/audit-service.port";
import { PostgresAuditService } from "../tenants/ports/postgres/postgres-audit.service";
import { EncryptionController } from "./encryption.controller";
import { EncryptionService } from "./encryption.service";

// Registers KmsServicePort behind an environment switch, per this WO's
// acceptance criteria ("mock for test/dev, real for staging/prod"). Only
// the mock branch is implemented — see kms-service.port.ts's header
// comment for why a real AWS KMS adapter isn't built here yet (the cloud
// provider decision this WO's description calls out as still pending).
// KMS_ADAPTER=aws fails loudly rather than silently falling back, so a
// misconfigured deployment can't accidentally run BYOK-critical crypto
// against the in-memory mock.
@Module({
  controllers: [EncryptionController],
  providers: [
    EncryptionService,
    TenantKeyMetadataRepository,
    { provide: AUDIT_SERVICE, useClass: PostgresAuditService },
    {
      provide: KMS_SERVICE,
      useFactory: () => {
        const adapter = process.env.KMS_ADAPTER ?? "mock";
        if (adapter === "mock") {
          return new InMemoryKmsService();
        }
        throw new Error(
          `KMS_ADAPTER=${adapter} is not implemented. Only "mock" is available today — a real AWS KMS adapter is tracked as follow-up work pending the cloud provider decision (see kms-service.port.ts).`,
        );
      },
    },
  ],
  exports: [EncryptionService, KMS_SERVICE, TenantKeyMetadataRepository],
})
export class EncryptionModule {}
