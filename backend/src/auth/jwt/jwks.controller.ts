import { Controller, Get, Header } from "@nestjs/common";
import { NoPermissionRequired } from "../../rbac/no-permission-required.decorator";
import { JwtKeyService } from "./jwt-key.service";

@Controller("api/v1/auth/.well-known")
export class JwksController {
  constructor(private readonly keyService: JwtKeyService) {}

  @Get("jwks.json")
  @NoPermissionRequired()
  // Public keys change at most once per rotation (every ~23 days) —
  // a short cache is still useful for the high-frequency callers every
  // other service's token-verification path represents, without risking
  // a stale key set surviving long past an actual rotation.
  @Header("Cache-Control", "public, max-age=3600")
  getJwks() {
    return { keys: this.keyService.activePublicJwks() };
  }
}
