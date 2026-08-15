import { IsString, IsUrl, MinLength } from "class-validator";

export class CreateWebhookConfigDto {
  @IsUrl({ require_tld: false }) // require_tld: false so http://localhost mock servers validate in local dev/CI
  url!: string;

  @IsString()
  @MinLength(16)
  secret!: string;
}
