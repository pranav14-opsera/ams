import { IsIn, IsInt, IsOptional, Max, Min } from "class-validator";
import { Transform } from "class-transformer";
import { TRACE_STATUSES, type TraceStatus } from "../../traces/trace.types";

const toNumber = ({ value }: { value: unknown }) => (value === undefined || value === "" ? undefined : Number(value));

export class AgentTracesQueryDto {
  @IsOptional()
  @IsIn(TRACE_STATUSES)
  status?: TraceStatus;

  @IsOptional()
  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @Transform(toNumber)
  @IsInt()
  @Min(0)
  offset?: number;
}
