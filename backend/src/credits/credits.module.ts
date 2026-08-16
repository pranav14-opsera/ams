import { Module } from "@nestjs/common";
import { AUDIT_SERVICE } from "../tenants/ports/audit-service.port";
import { PostgresAuditService } from "../tenants/ports/postgres/postgres-audit.service";
import { CreditCacheCircuitBreakerService } from "./credit-cache-circuit-breaker.service";
import { CreditCacheService } from "./credit-cache.service";
import { CreditConsumptionKafkaProducerService } from "./credit-consumption-kafka-producer.service";
import { CreditLedgerController } from "./credit-ledger.controller";
import { CreditLedgerService } from "./credit-ledger.service";
import { CreditRateMappingRepository } from "./credit-rate-mapping.repository";
import { CreditRateMappingService } from "./credit-rate-mapping.service";
import { CreditTransactionRepository } from "./credit-transaction.repository";
import { MeteringEngineService } from "./metering-engine.service";

@Module({
  controllers: [CreditLedgerController],
  providers: [
    CreditTransactionRepository,
    CreditLedgerService,
    CreditRateMappingRepository,
    CreditRateMappingService,
    CreditCacheService,
    CreditCacheCircuitBreakerService,
    CreditConsumptionKafkaProducerService,
    MeteringEngineService,
    { provide: AUDIT_SERVICE, useClass: PostgresAuditService },
  ],
  exports: [CreditTransactionRepository, CreditLedgerService, CreditRateMappingService, MeteringEngineService, CreditCacheCircuitBreakerService],
})
export class CreditsModule {}
