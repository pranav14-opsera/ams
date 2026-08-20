import { IsArray, IsInt, IsObject, Max, Min } from "class-validator";

export class SaveOnboardingProgressDto {
  @IsInt()
  @Min(1)
  @Max(6)
  currentStep!: number;

  @IsObject()
  stepData!: Record<string, unknown>;

  @IsArray()
  completedSteps!: number[];
}
