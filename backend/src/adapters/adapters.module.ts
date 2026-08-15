import { Module } from "@nestjs/common";
import { AgentsRepository } from "../agents/agents.repository";
import { ClassificationModule } from "../classification/classification.module";
import { EncryptionModule } from "../encryption/encryption.module";
import { PhiScrubberModule } from "../phi-scrubber/phi-scrubber.module";
import { TenantsModule } from "../tenants/tenants.module";
import { AdapterRegistryService } from "./adapter-registry.service";
import { AdaptersController } from "./adapters.controller";
import { HmacValidationMiddleware } from "./hmac-validation.middleware";
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
    { provide: TELEMETRY_PUBLISHER, useClass: KafkaTelemetryProducerService },
  ],
  exports: [HmacValidationMiddleware],
})
export class AdaptersModule {}
