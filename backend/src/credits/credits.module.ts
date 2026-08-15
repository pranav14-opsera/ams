import { Module } from "@nestjs/common";
import { AUDIT_SERVICE } from "../tenants/ports/audit-service.port";
import { PostgresAuditService } from "../tenants/ports/postgres/postgres-audit.service";
import { CreditLedgerController } from "./credit-ledger.controller";
import { CreditLedgerService } from "./credit-ledger.service";
import { CreditTransactionRepository } from "./credit-transaction.repository";

@Module({
  controllers: [CreditLedgerController],
  providers: [CreditTransactionRepository, CreditLedgerService, { provide: AUDIT_SERVICE, useClass: PostgresAuditService }],
  exports: [CreditTransactionRepository, CreditLedgerService],
})
export class CreditsModule {}
