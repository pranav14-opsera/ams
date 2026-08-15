import { ArrayMaxSize, ArrayUnique, IsArray, IsIn, IsObject, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import type { AgentFramework } from "./create-agent.dto";
import { AGENT_LIFECYCLE_STATUSES, type AgentLifecycleStatus } from "./list-agents-query.dto";

// A plain interface (validated field-by-field in BulkLifecycleService, not
// via @ValidateNested()/@Type()) — @Type() depends on Reflect.getMetadata,
// which this codebase's tsx-run unit tests crash on outright (see
// list-agents-query.dto.ts's toNumber comment for the full story).
export interface BulkLifecycleFilter {
  teamId?: string;
  framework?: AgentFramework;
  currentStatus?: AgentLifecycleStatus;
}

export class BulkLifecycleDto {
  // Exactly one of agentIds/filter is expected — enforced in
  // BulkLifecycleService (a class-validator decorator can't easily express
  // "exactly one of these two" without @ValidateIf on both fields
  // referencing each other, which is more confusing than a plain runtime
  // check in the service).
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  agentIds?: string[];

  @IsOptional()
  @IsObject()
  filter?: BulkLifecycleFilter;

  @IsIn(AGENT_LIFECYCLE_STATUSES)
  targetStatus!: AgentLifecycleStatus;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  justification?: string;
}
