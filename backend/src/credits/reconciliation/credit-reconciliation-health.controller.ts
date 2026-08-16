import { Controller, Get } from "@nestjs/common";
import { NoPermissionRequired } from "../../rbac/no-permission-required.decorator";
import { CreditConsumptionDlqProducerService } from "./credit-consumption-dlq-producer.service";
import { CreditReconciliationService } from "./credit-reconciliation.service";

export interface ReconciliationHealthResponse {
  /**
   * Genuine Kafka consumer-group lag requires a reachable broker's admin
   * API (kafkajs's Admin client, fetchOffsets/fetchTopicOffsets) — none
   * is reachable in this sandbox (same documented gap as every other
   * Kafka integration this session), so this is honestly null rather
   * than a fabricated number, with the reason stated alongside it.
   */
  consumerGroupLag: number | null;
  consumerGroupLagUnavailableReason: string | null;
  lastSuccessfulBatchAt: string | null;
  dlqMessageCount: number;
}

// Same global, tenant-less, unauthenticated convention as health.controller.ts's own routes (this endpoint reports a Kafka consumer group's own state, not any one tenant's data) — see app.module.ts's PRE_AUTH_ROUTES.
@Controller("health/credit-reconciliation")
export class CreditReconciliationHealthController {
  constructor(
    private readonly reconciliationService: CreditReconciliationService,
    private readonly dlqProducer: CreditConsumptionDlqProducerService,
  ) {}

  @Get()
  @NoPermissionRequired()
  getHealth(): ReconciliationHealthResponse {
    const lastSuccessfulBatchAt = this.reconciliationService.getLastSuccessfulBatchAt();
    return {
      consumerGroupLag: null,
      consumerGroupLagUnavailableReason: "no reachable Kafka broker admin client in this environment",
      lastSuccessfulBatchAt: lastSuccessfulBatchAt ? lastSuccessfulBatchAt.toISOString() : null,
      dlqMessageCount: this.dlqProducer.getDlqMessageCount(),
    };
  }
}
