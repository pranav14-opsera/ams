import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { PermissionName } from "../../rbac/rbac.constants";
import { RequireAnyPermission } from "../../rbac/require-any-permission.decorator";
import { RequirePermission } from "../../rbac/require-permission.decorator";
import { ResourceTeamParam } from "../../rbac/resource-team-param.decorator";
import { AllocateBudgetDto } from "./dto/allocate-budget.dto";
import { BudgetPeriodQueryDto } from "./dto/budget-period-query.dto";
import { UpsertPoolDto } from "./dto/upsert-pool.dto";
import { CreditBudgetService } from "./credit-budget.service";

function currentPeriod(query: BudgetPeriodQueryDto, now: Date = new Date()): { month: number; year: number } {
  return { month: query.month ?? now.getUTCMonth() + 1, year: query.year ?? now.getUTCFullYear() };
}

@Controller("api/v1/credits")
export class CreditBudgetController {
  constructor(private readonly service: CreditBudgetService) {}

  // WO-082 Step 5: provisions the org's own credit pool for a period —
  // see CreditBudgetService.upsertPool's own comment for why this route
  // exists (allocate() requires a pool to already exist; onboarding is
  // the first caller with no separate billing process to have created one).
  @Post("pool")
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission(PermissionName.CREDIT_ALLOCATION_MANAGE)
  async upsertPool(@Body() dto: UpsertPoolDto, @Req() req: Request) {
    return this.service.upsertPool(req.tenantId!, req.actorId ?? null, dto.effectiveMonth, dto.effectiveYear, dto.totalCredits);
  }

  // AC: only Finance Manager and Platform Administrator can allocate.
  @Post("allocate")
  @HttpCode(HttpStatus.CREATED)
  @RequirePermission(PermissionName.CREDIT_ALLOCATION_MANAGE)
  async allocate(@Body() dto: AllocateBudgetDto, @Req() req: Request) {
    return this.service.allocate(req.tenantId!, req.actorId ?? null, {
      teamId: dto.teamId,
      allocatedCredits: dto.allocatedCredits,
      alertThreshold75: dto.alertThreshold75,
      alertThreshold90: dto.alertThreshold90,
      hardCap: dto.hardCap ?? null,
      effectiveMonth: dto.effectiveMonth,
      effectiveYear: dto.effectiveYear,
      justification: dto.justification ?? null,
    });
  }

  // Org-wide list — Finance Manager/Platform Administrator only (a Team Lead's own team is covered by the :teamId route below, not this list).
  @Get("budgets")
  @RequirePermission(PermissionName.CREDIT_CONSUMPTION_VIEW_ORG)
  async listBudgets(@Query() query: BudgetPeriodQueryDto, @Req() req: Request) {
    const { month, year } = currentPeriod(query);
    return this.service.listBudgets(req.tenantDbClient, req.tenantId!, month, year);
  }

  // AC: "Team Lead can view their team's allocation. Agent Operator can view their team's remaining balance." Both are team-scoped roles — RbacGuard's own ResourceTeamParam check (using this route's own :teamId param) denies them for any team other than one they actually belong to; org-level roles pass straight through.
  @Get("budgets/:teamId")
  @RequireAnyPermission([PermissionName.CREDIT_CONSUMPTION_VIEW_ORG, PermissionName.CREDIT_CONSUMPTION_VIEW_TEAM, PermissionName.CREDIT_CONSUMPTION_VIEW_PERSONAL])
  @ResourceTeamParam("teamId")
  async getTeamBudget(@Param("teamId") teamId: string, @Query() query: BudgetPeriodQueryDto, @Req() req: Request) {
    const { month, year } = currentPeriod(query);
    return this.service.getTeamBudget(req.tenantDbClient, req.tenantId!, teamId, month, year);
  }
}
