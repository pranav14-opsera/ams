import { Injectable } from "@nestjs/common";
import type { AgentFrameworkType } from "./schemas/canonical-telemetry";
import type { IAgentAdapter } from "./interfaces/agent-adapter.interface";

/**
 * Maps a framework_type to the concrete adapter that translates its raw
 * telemetry into the canonical schema. Empty in production until
 * WO-035/036/037/038 (LangChain/REST/CrewAI/AutoGen adapters) register
 * themselves here — this WO defines the registry and the contract, not
 * any specific framework's adapter.
 */
@Injectable()
export class AdapterRegistryService {
  private readonly adapters = new Map<AgentFrameworkType, IAgentAdapter>();

  register(frameworkType: AgentFrameworkType, adapter: IAgentAdapter): void {
    this.adapters.set(frameworkType, adapter);
  }

  get(frameworkType: string): IAgentAdapter | undefined {
    return this.adapters.get(frameworkType as AgentFrameworkType);
  }
}
