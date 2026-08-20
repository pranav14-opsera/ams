import { Transform } from "class-transformer";
import { IsArray, IsIn, IsOptional, IsUUID } from "class-validator";
import { TEAM_USAGE_FRAMEWORKS, TEAM_USAGE_GRANULARITIES, TEAM_USAGE_PERIODS, type TeamUsageFramework, type TeamUsageGranularity, type TeamUsagePeriod } from "../team-usage-dashboard.types";

// team_id is deliberately NOT enforced via RbacGuard's @ResourceTeamParam
// (which only reads route path params) — TeamUsageDashboardService.
// resolveTeamId does its own real membership check (throws
// ForbiddenException for a team-scoped caller requesting a team they
// don't belong to) directly against TeamMembershipRepository, so the
// authorization is real regardless of query-vs-path-param plumbing.
// team_id stays a query param (not a route param) because it's OPTIONAL
// here — an org-scoped caller (Platform Administrator) may omit it
// entirely and get the tenant's first team by default (api_contracts),
// which a route path param can't express as cleanly.

// Comma-separated multi-value query params (?agents=uuid,uuid) are this
// codebase's own established convention for array filters over HTTP —
// same shape as list-agents-query.dto.ts's own comma-split handling.
// Splitting is defensive against both a single value and an already-array
// value (some HTTP clients send repeated `agents=` params instead, which
// Express/qs parses as a real array already).
function splitCsv({ value }: { value: unknown }): string[] | undefined {
  if (value === undefined || value === "") return undefined;
  if (Array.isArray(value)) return value.flatMap((v) => String(v).split(","));
  return String(value)
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/**
 * AC/api_contracts: `GET /api/v1/dashboards/usage/team` query params.
 * Property names deliberately match the API contract's own literal
 * snake_case wire names (team_id, action_types) rather than this
 * codebase's usual camelCase DTO convention (ConsumptionQueryDto's
 * startDate, etc.) — NestJS's default @Query() binding maps a DTO
 * property directly to the query string key of the same name with no
 * renaming layer, so matching the contract's literal names here is what
 * actually makes `?team_id=...&action_types=...` bind at all.
 *
 * OWASP A05 (edge_cases: "malicious/invalid URL query params rejected
 * server-side with 400"): every field is allowlist-validated
 * (@IsIn/@IsUUID) rather than passed through — an invalid period,
 * framework, or non-UUID agent/team id fails NestJS's global
 * ValidationPipe with a 400, never reaches a raw SQL string.
 */
export class TeamUsageQueryDto {
  @IsOptional()
  @IsUUID()
  team_id?: string;

  @IsOptional()
  @IsIn(TEAM_USAGE_PERIODS)
  period?: TeamUsagePeriod;

  @IsOptional()
  @IsIn(TEAM_USAGE_GRANULARITIES)
  granularity?: TeamUsageGranularity;

  @IsOptional()
  @Transform(splitCsv)
  @IsArray()
  @IsUUID(undefined, { each: true })
  agents?: string[];

  // Free-text action types (agent_execution, tool_call, etc. — this
  // codebase never enumerates the full action_type vocabulary anywhere,
  // see credit_transactions.action_type's own free-text column) — allowed
  // through as a plain string allowlist-shaped array (length/charset
  // bounded, not IsIn'd against a fixed list), and always used as a
  // parameterized `= ANY($n::text[])` bind at the repository layer, never
  // string-concatenated into SQL (OWASP A05/semgrep raw-sql-string-concat).
  @IsOptional()
  @Transform(splitCsv)
  @IsArray()
  action_types?: string[];

  @IsOptional()
  @Transform(splitCsv)
  @IsArray()
  @IsIn(TEAM_USAGE_FRAMEWORKS, { each: true })
  frameworks?: TeamUsageFramework[];
}
