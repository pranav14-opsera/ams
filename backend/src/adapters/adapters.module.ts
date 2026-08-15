import { Module } from "@nestjs/common";
import { AgentsRepository } from "../agents/agents.repository";
import { ClassificationModule } from "../classification/classification.module";
import { EncryptionModule } from "../encryption/encryption.module";
import { PhiScrubberModule } from "../phi-scrubber/phi-scrubber.module";
import { TenantsModule } from "../tenants/tenants.module";
import { AdapterRegistryService } from "./adapter-registry.service";
import { AdaptersController } from "./adapters.controller";
import { HmacValidationMiddleware } from "./hmac-validation.middleware";
import { KafkaCircuitBreakerProducerService } from "./kafka/kafka-circuit-breaker-producer.service";
import { KafkaTelemetryProducerService } from "./kafka/kafka-telemetry-producer.service";
import { TelemetryDeadLetterRepository } from "./kafka/telemetry-dead-letter.repository";
import { TELEMETRY_PUBLISHER } from "./kafka/telemetry-publisher.port";
import { TelemetryPipelineService } from "./pipeline/telemetry-pipeline.service";
import { TelemetrySchemaValidatorService } from "./telemetry-schema-validator.service";

@Module({
  imports: [EncryptionModule, ClassificationModule, PhiScrubberModule, TenantsModule],
  controllers: [AdaptersController],
  providers: [
    AgentsRepository,
    AdapterRegistryService,
    HmacValidationMiddleware,
    TelemetrySchemaValidatorService,
    TelemetryDeadLetterRepository,
    TelemetryPipelineService,
    KafkaTelemetryProducerService,
    // WO-040: the publisher every caller actually injects is the circuit
    // breaker (3-failure threshold, 5s reset, 5-minute in-memory replay
    // buffer) wrapping the real KafkaJS producer — not the bare producer
    // itself.
    { provide: TELEMETRY_PUBLISHER, useClass: KafkaCircuitBreakerProducerService },
  ],
  // AdapterRegistryService exported so per-framework adapter modules
  // (LangChainModule, and WO-036/037/038's REST/CrewAI/AutoGen modules)
  // register themselves into the SAME registry instance the ingestion
  // controller actually queries — each importing its own separate
  // AdapterRegistryService provider would silently register into an
  // instance nothing ever reads from.
  exports: [HmacValidationMiddleware, AdapterRegistryService],
})
export class AdaptersModule {}
