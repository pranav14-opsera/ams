import { Module, type OnModuleInit } from "@nestjs/common";
import { AdapterRegistryService } from "../adapter-registry.service";
import { AdaptersModule } from "../adapters.module";
import { CrewAiAdapter } from "./crewai-adapter";
import { CrewAiConnectionValidator } from "./crewai-connection-validator";

@Module({
  imports: [AdaptersModule],
  providers: [CrewAiConnectionValidator, CrewAiAdapter],
  exports: [CrewAiAdapter],
})
export class CrewAiModule implements OnModuleInit {
  constructor(
    private readonly registry: AdapterRegistryService,
    private readonly adapter: CrewAiAdapter,
  ) {}

  onModuleInit(): void {
    this.registry.register("crewai", this.adapter);
  }
}
