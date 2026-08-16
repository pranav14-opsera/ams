import { Transform } from "class-transformer";
import { IsInt, IsOptional, Max, Min } from "class-validator";

// Same `@Transform` (not `@Type(() => Number)`) convention as list-agents-query.dto.ts — `@Type` needs Reflect.getMetadata from a full Nest bootstrap, which this codebase's tsx-run unit tests don't have.
const toNumber = ({ value }: { value: unknown }) => (value === undefined || value === "" ? undefined : Number(value));

export class BudgetPeriodQueryDto {
  @IsOptional()
  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(12)
  month?: number;

  @IsOptional()
  @Transform(toNumber)
  @IsInt()
  @Min(2020)
  year?: number;
}
