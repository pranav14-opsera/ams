import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Max, Min } from "class-validator";

export class AllocateBudgetDto {
  @IsUUID()
  teamId!: string;

  @IsInt()
  @Min(0)
  allocatedCredits!: number;

  @IsBoolean()
  alertThreshold75!: boolean;

  @IsBoolean()
  alertThreshold90!: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  hardCap?: number;

  @IsInt()
  @Min(1)
  @Max(12)
  effectiveMonth!: number;

  @IsInt()
  @Min(2020)
  effectiveYear!: number;

  @IsOptional()
  @IsString()
  justification?: string;
}
