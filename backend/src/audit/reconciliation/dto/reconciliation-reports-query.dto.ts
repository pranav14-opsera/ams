import { IsIn, IsISO8601, IsOptional } from "class-validator";

export class ReconciliationReportsQueryDto {
  @IsOptional()
  @IsIn(["daily_reconciliation", "monthly_deep_sample"])
  reportType?: "daily_reconciliation" | "monthly_deep_sample";

  @IsOptional()
  @IsISO8601()
  since?: string;

  @IsOptional()
  @IsISO8601()
  until?: string;
}
