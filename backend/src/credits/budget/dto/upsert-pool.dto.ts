import { IsInt, Max, Min } from "class-validator";

export class UpsertPoolDto {
  @IsInt()
  @Min(0)
  totalCredits!: number;

  @IsInt()
  @Min(1)
  @Max(12)
  effectiveMonth!: number;

  @IsInt()
  @Min(2020)
  effectiveYear!: number;
}
