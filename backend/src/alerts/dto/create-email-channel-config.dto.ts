import { ArrayMinSize, IsArray, IsEmail } from "class-validator";

export class CreateEmailChannelConfigDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsEmail({}, { each: true })
  recipients!: string[];
}
