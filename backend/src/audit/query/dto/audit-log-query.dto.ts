import { IsBoolean, IsISO8601, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from "class-validator";
import { Transform, Type } from "class-transformer";

const DATA_CLASSIFICATIONS = ["public", "internal", "confidential", "restricted"];

export class AuditLogQueryDto {
  // Required per this WO's AC ("time range (required)").
  @IsISO8601()
  startTime!: string;

  @IsISO8601()
  endTime!: string;

  @IsOptional()
  @IsUUID()
  actorId?: string;

  @IsOptional()
  @IsString()
  action?: string;

  @IsOptional()
  @IsString()
  resourceType?: string;

  @IsOptional()
  @IsString()
  resourceId?: string;

  @IsOptional()
  @IsIn(DATA_CLASSIFICATIONS)
  dataClassification?: string;

  @IsOptional()
  @IsString()
  correlationId?: string;

  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;

  // AC (WO-049 query federation): "GET /api/v1/audit/logs endpoint with a
  // cold_storage=true parameter." Query strings arrive as the literal text
  // "true"/"false", never a real boolean — Transform normalizes both that
  // and the (falsy-but-present) empty-string case before IsBoolean runs.
  @IsOptional()
  @Transform(({ value }) => (value === "true" ? true : value === "false" ? false : value))
  @IsBoolean()
  cold_storage?: boolean;
}
