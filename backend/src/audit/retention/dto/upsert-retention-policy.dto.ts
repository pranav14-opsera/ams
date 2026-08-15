import { IsIn, IsInt, Min } from "class-validator";
import { DATA_CATEGORIES } from "../retention-policy.constants";

export class UpsertRetentionPolicyDto {
  @IsIn(DATA_CATEGORIES)
  dataCategory!: "audit_logs" | "execution_traces" | "usage_metrics";

  @IsInt()
  @Min(1)
  retentionDays!: number;
}
