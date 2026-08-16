import { Module } from "@nestjs/common";
import { AUDIT_SERVICE } from "../../tenants/ports/audit-service.port";
import { PostgresAuditService } from "../../tenants/ports/postgres/postgres-audit.service";
import { CreditBudgetController } from "./credit-budget.controller";
import { CreditBudgetRepository } from "./credit-budget.repository";
import { CreditBudgetService } from "./credit-budget.service";

@Module({
  controllers: [CreditBudgetController],
  providers: [CreditBudgetRepository, CreditBudgetService, { provide: AUDIT_SERVICE, useClass: PostgresAuditService }],
  exports: [CreditBudgetRepository, CreditBudgetService],
})
export class CreditBudgetModule {}
