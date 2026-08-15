import { Module } from "@nestjs/common";
import { AuditStoreRepository } from "./audit-store.repository";

@Module({
  providers: [AuditStoreRepository],
  exports: [AuditStoreRepository],
})
export class AuditModule {}
