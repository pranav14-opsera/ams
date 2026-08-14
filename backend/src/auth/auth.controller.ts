import { BadRequestException, Body, Controller, Get, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { AuthService } from "./auth.service";

class SamlCallbackDto {
  SAMLResponse!: string;
  RelayState!: string; // carries tenantId — round-tripped through the IdP, standard SAML usage of RelayState
}

// Pre-authentication endpoints (no platform JWT exists yet — that's the
// entire point of this exchange) — excluded from TenantContextMiddleware
// in app.module.ts, same as the health endpoints.
@Controller("api/v1/auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post("saml/callback")
  async samlCallback(@Body() body: SamlCallbackDto, @Req() req: Request) {
    if (!body.RelayState) {
      throw new BadRequestException("Missing RelayState (tenant identifier).");
    }
    const callbackUrl = this.callbackUrl(req, "saml/callback");
    const token = await this.authService.handleSamlCallback(body.RelayState, body.SAMLResponse, callbackUrl, req.ip ?? null);
    return { access_token: token, token_type: "Bearer" };
  }

  @Get("oidc/callback")
  async oidcCallback(@Query("code") code: string, @Query("state") tenantId: string, @Req() req: Request) {
    if (!tenantId) {
      throw new BadRequestException("Missing state (tenant identifier).");
    }
    const callbackUrl = this.callbackUrl(req, "oidc/callback");
    const token = await this.authService.handleOidcCallback(tenantId, code, callbackUrl, req.ip ?? null);
    return { access_token: token, token_type: "Bearer" };
  }

  private callbackUrl(req: Request, path: string): string {
    return `${req.protocol}://${req.get("host")}/api/v1/auth/${path}`;
  }
}
