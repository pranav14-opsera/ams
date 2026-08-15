import { IsObject, IsOptional, IsUUID, MaxLength, MinLength } from "class-validator";

export class UpdateAgentDto {
  @IsOptional()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsUUID()
  teamId?: string;

  // Present only if the caller is actually rotating credentials —
  // omitted means "leave connection_config as it is now", re-encrypting
  // it unnecessarily otherwise would be needless KMS churn.
  @IsOptional()
  @IsObject()
  connectionConfig?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
