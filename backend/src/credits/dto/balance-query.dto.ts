import { IsOptional, IsUUID } from "class-validator";

export class BalanceQueryDto {
  @IsOptional()
  @IsUUID()
  teamId?: string;
}
