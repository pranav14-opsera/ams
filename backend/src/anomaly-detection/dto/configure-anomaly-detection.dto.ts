import { IsBoolean, IsIn, IsOptional } from "class-validator";
import { SENSITIVITY_LEVELS, type SensitivityLevel } from "../anomaly-detection.types";

export class ConfigureAnomalyDetectionDto {
  @IsIn(SENSITIVITY_LEVELS)
  sensitivity!: SensitivityLevel;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
