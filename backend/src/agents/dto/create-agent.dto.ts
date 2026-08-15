import { IsIn, IsObject, IsOptional, IsString, IsUUID, MaxLength, MinLength } from "class-validator";

// Matches the CHECK constraint exactly (database/migrations/004_create_agents.sql).
// "generic_rest" (not "rest") is the established DB enum value — this
// WO's own description shorthands it as "rest", but the schema predates
// this WO and nothing else in this codebase uses "rest" as the literal
// value, so this is what's actually stored, not a naming drift to fix.
export const AGENT_FRAMEWORKS = ["langchain", "crewai", "autogen", "generic_rest"] as const;
export type AgentFramework = (typeof AGENT_FRAMEWORKS)[number];

export class CreateAgentDto {
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsIn(AGENT_FRAMEWORKS)
  framework!: AgentFramework;

  @IsOptional()
  @IsUUID()
  teamId?: string;

  // Restricted-tier credential material (WO-016) — BYOK-encrypted before
  // storage (WO-015), never persisted or returned in plaintext.
  @IsObject()
  connectionConfig!: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  // Optional — WO-039's compatibility check. Never blocks registration
  // (AC: "a warning is returned, not a hard block") — omitted entirely
  // when the caller doesn't report a version, since there's nothing to
  // check against.
  @IsOptional()
  @IsString()
  frameworkVersion?: string;
}
