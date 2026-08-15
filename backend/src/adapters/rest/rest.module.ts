import { Module, type OnModuleInit } from "@nestjs/common";
import { AdapterRegistryService } from "../adapter-registry.service";
import { AdaptersModule } from "../adapters.module";
import { GenericRestAdapter } from "./rest-adapter";
import { RestConnectionValidator } from "./rest-connection-validator";
import { RestTelemetryValidatorService } from "./rest-telemetry-validator.service";

@Module({
  imports: [AdaptersModule],
  providers: [RestConnectionValidator, RestTelemetryValidatorService, GenericRestAdapter],
  exports: [GenericRestAdapter],
})
export class RestModule implements OnModuleInit {
  constructor(
    private readonly registry: AdapterRegistryService,
    private readonly adapter: GenericRestAdapter,
  ) {}

  onModuleInit(): void {
    this.registry.register("generic_rest", this.adapter);
  }
}
