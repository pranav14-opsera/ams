import { IsIn, IsObject, IsOptional, IsString, Length, Matches } from "class-validator";

export class CreateTenantDto {
  @IsString()
  @Length(1, 128)
  name!: string;

  @IsString()
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: "slug must be lowercase alphanumeric segments separated by hyphens (e.g. acme-health)",
  })
  @Length(1, 128)
  slug!: string;

  @IsIn(["us", "eu"])
  dataResidencyRegion!: "us" | "eu";

  @IsOptional()
  @IsObject()
  settings?: Record<string, unknown>;
}
