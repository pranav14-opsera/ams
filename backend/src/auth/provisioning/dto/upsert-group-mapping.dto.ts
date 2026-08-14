import { IsIn, IsInt, IsString, Min, MinLength } from "class-validator";
import { ALL_PLATFORM_ROLE_NAMES, type PlatformRoleName } from "../../../rbac/rbac.constants";

export class UpsertGroupMappingDto {
  @IsString()
  @MinLength(1)
  idpGroup!: string;

  @IsIn(ALL_PLATFORM_ROLE_NAMES)
  platformRole!: PlatformRoleName;

  @IsInt()
  @Min(0)
  priority!: number;
}
