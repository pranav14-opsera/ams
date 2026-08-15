import { IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from "class-validator";
import { Transform } from "class-transformer";
import { AGENT_FRAMEWORKS, type AgentFramework } from "./create-agent.dto";

// `@Transform` (a plain value-mapping function), not `@Type(() =>
// Number)` — `@Type` relies on `Reflect.getMetadata`, which is only
// polyfilled by importing "reflect-metadata" (done implicitly by
// @nestjs/core in the real app, verified via verify-boot.js against the
// compiled build) — this codebase's tsx-run unit tests import DTOs
// directly without that bootstrap chain, so `@Type` crashed the entire
// test process outright, found via testing.
const toNumber = ({ value }: { value: unknown }) => (value === undefined || value === "" ? undefined : Number(value));

export const AGENT_LIFECYCLE_STATUSES = ["connecting", "active", "paused", "retired", "decommissioned"] as const;
export type AgentLifecycleStatus = (typeof AGENT_LIFECYCLE_STATUSES)[number];

export class ListAgentsQueryDto {
  @IsOptional()
  @IsUUID()
  teamId?: string;

  @IsOptional()
  @IsIn(AGENT_FRAMEWORKS)
  framework?: AgentFramework;

  @IsOptional()
  @IsIn(AGENT_LIFECYCLE_STATUSES)
  lifecycleStatus?: AgentLifecycleStatus;

  @IsOptional()
  @IsString()
  name?: string; // substring search

  @IsOptional()
  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @Transform(toNumber)
  @IsInt()
  @Min(0)
  offset?: number;
}
