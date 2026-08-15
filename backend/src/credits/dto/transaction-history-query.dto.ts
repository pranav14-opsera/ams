import { Transform } from "class-transformer";
import { IsDateString, IsInt, IsOptional, IsString, IsUUID, Max, Min } from "class-validator";

// Same `@Transform` (not `@Type(() => Number)`) convention as list-agents-query.dto.ts/list-agent-health-query.dto.ts — `@Type` needs Reflect.getMetadata from a full Nest bootstrap, which this codebase's tsx-run unit tests don't have.
const toNumber = ({ value }: { value: unknown }) => (value === undefined || value === "" ? undefined : Number(value));

export class TransactionHistoryQueryDto {
  @IsOptional()
  @IsUUID()
  agentId?: string;

  @IsOptional()
  @IsUUID()
  teamId?: string;

  @IsOptional()
  @IsString()
  actionType?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  @IsOptional()
  @Transform(toNumber)
  @IsInt()
  @Min(0)
  offset?: number;
}
