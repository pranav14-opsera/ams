import { IsString, Length } from "class-validator";

export class VerifyMfaDto {
  // 6-digit TOTP code or a 10-character backup code — deliberately not
  // constrained tighter than "non-empty, reasonably short string" here;
  // MfaService itself is what actually determines which kind (if either)
  // it matches, not input validation guessing the caller's intent.
  @IsString()
  @Length(6, 10)
  code!: string;
}
