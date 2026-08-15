import { IsISO8601, IsIn, IsOptional, IsString, IsUUID } from "class-validator";

const DATA_CLASSIFICATIONS = ["public", "internal", "confidential", "restricted"];

export class CreateAuditExportDto {
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
}
