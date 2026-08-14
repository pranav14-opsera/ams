import { IsOptional, IsString, MaxLength } from "class-validator";

export class CreateScimTokenDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;
}
