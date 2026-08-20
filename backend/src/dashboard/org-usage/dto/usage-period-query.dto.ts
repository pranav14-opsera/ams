import { IsIn, IsOptional } from "class-validator";
import { USAGE_GRANULARITIES, USAGE_PERIODS, type UsageGranularity, type UsagePeriod } from "../org-usage-dashboard.types";

export class UsagePeriodQueryDto {
  @IsOptional()
  @IsIn(USAGE_PERIODS)
  period?: UsagePeriod;

  @IsOptional()
  @IsIn(USAGE_GRANULARITIES)
  granularity?: UsageGranularity;
}
