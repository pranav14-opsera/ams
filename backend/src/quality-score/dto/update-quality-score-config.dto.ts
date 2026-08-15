import { IsInt, Max, Min } from "class-validator";

export class UpdateQualityScoreConfigDto {
  @IsInt()
  @Min(0)
  @Max(100)
  toolCallWeight!: number;

  @IsInt()
  @Min(0)
  @Max(100)
  reasoningWeight!: number;

  @IsInt()
  @Min(0)
  @Max(100)
  consistencyWeight!: number;
}
