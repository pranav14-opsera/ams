import { IsInt, Max, Min } from "class-validator";

export class UpdateSessionPolicyDto {
  @IsInt()
  @Min(300)
  @Max(3600)
  idleTimeoutSeconds!: number;

  @IsInt()
  @Min(3600)
  @Max(86400)
  absoluteTimeoutSeconds!: number;
}
