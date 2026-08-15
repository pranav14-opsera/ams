import { IsInt, IsNumber, IsOptional, Min } from "class-validator";

export class UpdateAlertThresholdDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  warningThreshold?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  criticalThreshold?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  cooldownSeconds?: number;
}
