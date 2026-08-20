import { IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from "class-validator";
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

// WO-079's Agent Registry AC: "filtering by framework type (multi-select...),
// lifecycle status (multi-select...)". Accepts either a comma-separated
// string (`?framework=langchain,crewai` — what useAgentRegistryQuery sends)
// or the array form Express/qs already produces for a repeated query key
// (`?framework=langchain&framework=crewai`) — either is a legitimate way for
// an HTTP client to express "more than one value for the same param".
const toArray = ({ value }: { value: unknown }) => {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value;
  return typeof value === "string" ? value.split(",").filter((v) => v.length > 0) : undefined;
};

export const AGENT_LIFECYCLE_STATUSES = ["connecting", "active", "paused", "retired", "decommissioned"] as const;
export type AgentLifecycleStatus = (typeof AGENT_LIFECYCLE_STATUSES)[number];

// WO-079: server-side sort for the Agent Registry table's own AC ("sorting
// by Name, Framework, Status, and Last Seen"). "lastSeen" sorts by the
// agents row's own `updated_at` — see agent.mapper.ts's own comment on why
// there's no dedicated heartbeat/last-seen column yet.
export const AGENT_SORT_FIELDS = ["name", "framework", "lifecycleStatus", "lastSeen"] as const;
export type AgentSortField = (typeof AGENT_SORT_FIELDS)[number];

export const SORT_ORDERS = ["asc", "desc"] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

export class ListAgentsQueryDto {
  @IsOptional()
  @IsUUID()
  teamId?: string;

  @IsOptional()
  @Transform(toArray)
  @IsArray()
  @IsIn(AGENT_FRAMEWORKS, { each: true })
  framework?: AgentFramework[];

  @IsOptional()
  @Transform(toArray)
  @IsArray()
  @IsIn(AGENT_LIFECYCLE_STATUSES, { each: true })
  lifecycleStatus?: AgentLifecycleStatus[];

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

  @IsOptional()
  @IsIn(AGENT_SORT_FIELDS)
  sortBy?: AgentSortField;

  @IsOptional()
  @IsIn(SORT_ORDERS)
  sortOrder?: SortOrder;
}
