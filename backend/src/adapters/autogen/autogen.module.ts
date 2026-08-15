import { Module, type OnModuleInit } from "@nestjs/common";
import { AdapterRegistryService } from "../adapter-registry.service";
import { AdaptersModule } from "../adapters.module";
import { AutoGenAdapter } from "./autogen-adapter";
import { AutoGenConnectionValidator } from "./autogen-connection-validator";

@Module({
  imports: [AdaptersModule],
  providers: [AutoGenConnectionValidator, AutoGenAdapter],
  exports: [AutoGenAdapter],
})
export class AutoGenModule implements OnModuleInit {
  constructor(
    private readonly registry: AdapterRegistryService,
    private readonly adapter: AutoGenAdapter,
  ) {}

  onModuleInit(): void {
    this.registry.register("autogen", this.adapter);
  }
}
