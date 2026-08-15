import { Module, type OnModuleInit } from "@nestjs/common";
import { AdapterRegistryService } from "../adapter-registry.service";
import { AdaptersModule } from "../adapters.module";
import { LangChainAdapter } from "./langchain-adapter";
import { LangChainConnectionValidator } from "./langchain-connection-validator";

@Module({
  imports: [AdaptersModule],
  providers: [LangChainConnectionValidator, LangChainAdapter],
  exports: [LangChainAdapter],
})
export class LangChainModule implements OnModuleInit {
  constructor(
    private readonly registry: AdapterRegistryService,
    private readonly adapter: LangChainAdapter,
  ) {}

  onModuleInit(): void {
    this.registry.register("langchain", this.adapter);
  }
}
