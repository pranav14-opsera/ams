import { IsBoolean, IsInt, Max, Min } from "class-validator";

export class UpdateMfaPolicyDto {
  @IsInt()
  @Min(5)
  @Max(480)
  restrictedElevationMinutes!: number;

  @IsBoolean()
  requireMfaForInternal!: boolean;

  @IsBoolean()
  requireMfaForPublic!: boolean;
}
