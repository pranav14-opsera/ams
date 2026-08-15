import { IsIn, IsInt, IsNumber, IsOptional, IsUUID, Min } from "class-validator";
import { ALERT_METRIC_NAMES, type AlertMetricName } from "../alert-threshold.types";

export class CreateAlertThresholdDto {
  @IsUUID()
  agentId!: string;

  @IsIn(ALERT_METRIC_NAMES)
  metricName!: AlertMetricName;

  @IsNumber()
  @Min(0)
  warningThreshold!: number;

  @IsNumber()
  @Min(0)
  criticalThreshold!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  cooldownSeconds?: number;
}
