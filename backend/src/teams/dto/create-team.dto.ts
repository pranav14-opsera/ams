import { MaxLength, MinLength } from "class-validator";

export class CreateTeamDto {
  @MinLength(1)
  @MaxLength(100)
  name!: string;
}
