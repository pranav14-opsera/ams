import { Transform } from "class-transformer";
import { IsDateString, IsIn, IsInt, IsOptional, Max, Min } from "class-validator";
import { CONSUMPTION_GROUP_BY, USAGE_GRANULARITIES, type ConsumptionGroupBy, type UsageGranularity } from "../org-usage-dashboard.types";

// Same tsx-run-tests-can't-use-@Type convention as list-agent-health-query.dto.ts / budget-period-query.dto.ts.
const toNumber = ({ value }: { value: unknown }) => (value === undefined || value === "" ? undefined : Number(value));

export class ConsumptionQueryDto {
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsIn(USAGE_GRANULARITIES)
  granularity?: UsageGranularity;

  @IsOptional()
  @IsIn(CONSUMPTION_GROUP_BY)
  groupBy?: ConsumptionGroupBy;

  @IsOptional()
  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;

  @IsOptional()
  @Transform(toNumber)
  @IsInt()
  @Min(0)
  offset?: number;
}
