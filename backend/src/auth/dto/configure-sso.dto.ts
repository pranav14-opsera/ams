import { IsIn, IsInt, IsOptional, IsString, IsUrl, Max, Min, ValidateIf } from "class-validator";

export class ConfigureSsoDto {
  @IsIn(["saml", "oidc"])
  protocol!: "saml" | "oidc";

  @ValidateIf((dto: ConfigureSsoDto) => dto.protocol === "saml")
  @IsUrl({ require_tld: false }, { message: "samlMetadataUrl must be a valid URL" })
  samlMetadataUrl?: string;

  @ValidateIf((dto: ConfigureSsoDto) => dto.protocol === "saml")
  @IsString()
  samlEntityId?: string;

  @ValidateIf((dto: ConfigureSsoDto) => dto.protocol === "oidc")
  @IsUrl({ require_tld: false }, { message: "oidcDiscoveryUrl must be a valid URL" })
  oidcDiscoveryUrl?: string;

  @ValidateIf((dto: ConfigureSsoDto) => dto.protocol === "oidc")
  @IsString()
  oidcClientId?: string;

  @ValidateIf((dto: ConfigureSsoDto) => dto.protocol === "oidc")
  @IsString()
  oidcClientSecret?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(24 * 7)
  metadataRefreshIntervalHours?: number;
}
