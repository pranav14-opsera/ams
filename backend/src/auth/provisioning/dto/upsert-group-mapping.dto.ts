import { IsIn, IsInt, IsString, Min, MinLength } from "class-validator";
import type { PlatformRole } from "../group-role-mapping.repository";

const PLATFORM_ROLES: PlatformRole[] = ["platform_admin", "compliance_officer", "finance_manager", "team_lead", "agent_operator"];

export class UpsertGroupMappingDto {
  @IsString()
  @MinLength(1)
  idpGroup!: string;

  @IsIn(PLATFORM_ROLES)
  platformRole!: PlatformRole;

  @IsInt()
  @Min(0)
  priority!: number;
}
