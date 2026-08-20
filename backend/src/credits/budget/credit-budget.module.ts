import { Module } from "@nestjs/common";
import { AUDIT_SERVICE } from "../../tenants/ports/audit-service.port";
import { PostgresAuditService } from "../../tenants/ports/postgres/postgres-audit.service";
import { CreditsModule } from "../credits.module";
import { CreditBudgetController } from "./credit-budget.controller";
import { CreditBudgetRepository } from "./credit-budget.repository";
import { CreditBudgetService } from "./credit-budget.service";

@Module({
  // CreditsModule: only for CreditRateMappingService — WO-070's own
  // hard_cap reconciliation between this module's credit_budgets.hard_cap
  // and CreditsModule's team_credit_limits.hard_cap. CreditsModule has no
  // imports back into this module, so this stays a one-directional edge.
  imports: [CreditsModule],
  controllers: [CreditBudgetController],
  providers: [CreditBudgetRepository, CreditBudgetService, { provide: AUDIT_SERVICE, useClass: PostgresAuditService }],
  exports: [CreditBudgetRepository, CreditBudgetService],
})
export class CreditBudgetModule {}
