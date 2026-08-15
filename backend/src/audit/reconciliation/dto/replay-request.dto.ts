import { IsISO8601 } from "class-validator";

export class ReplayRequestDto {
  @IsISO8601()
  since!: string;

  @IsISO8601()
  until!: string;
}
