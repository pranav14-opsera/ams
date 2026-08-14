import { IsObject } from "class-validator";

export class UpdateTenantSettingsDto {
  @IsObject()
  settings!: Record<string, unknown>;
}
