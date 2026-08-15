import { IsIn, IsOptional } from "class-validator";
import { TIME_RANGES, type TimeRange } from "../health-history.util";

export class AgentHealthHistoryQueryDto {
  @IsOptional()
  @IsIn(TIME_RANGES)
  range?: TimeRange;
}
