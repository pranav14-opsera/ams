import { Controller, Get, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { PermissionName } from "../rbac/rbac.constants";
import { RequirePermission } from "../rbac/require-permission.decorator";
import { BalanceQueryDto } from "./dto/balance-query.dto";
import { TransactionHistoryQueryDto } from "./dto/transaction-history-query.dto";
import { CreditLedgerService } from "./credit-ledger.service";

const DEFAULT_HISTORY_LIMIT = 50;

/**
 * AC: GET .../balance and GET .../consumption. Team/personal-scoped
 * visibility (CREDIT_CONSUMPTION_VIEW_TEAM/_PERSONAL) is a future
 * credit-metering WO's concern — this foundational ledger WO gates both
 * reads at the org-wide permission, the same "closest existing grant"
 * precedent this whole project uses when a finer-grained scoping
 * mechanism doesn't exist yet.
 */
@Controller("api/v1/credits")
export class CreditLedgerController {
  constructor(private readonly service: CreditLedgerService) {}

  @Get("balance")
  @RequirePermission(PermissionName.CREDIT_CONSUMPTION_VIEW_ORG)
  async getBalance(@Query() query: BalanceQueryDto, @Req() req: Request) {
    return this.service.getBalance(req.tenantDbClient, req.tenantId!, query.teamId ?? null);
  }

  @Get("consumption")
  @RequirePermission(PermissionName.CREDIT_CONSUMPTION_VIEW_ORG)
  async getConsumption(@Query() query: TransactionHistoryQueryDto, @Req() req: Request) {
    return this.service.getTransactionHistory(req.tenantDbClient, req.tenantId!, {
      agentId: query.agentId,
      teamId: query.teamId,
      actionType: query.actionType,
      startDate: query.startDate,
      endDate: query.endDate,
      limit: query.limit ?? DEFAULT_HISTORY_LIMIT,
      offset: query.offset ?? 0,
    });
  }
}
