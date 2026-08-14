import { BadRequestException, Body, Controller, Get, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { AuthService } from "./auth.service";
import { computeDeviceFingerprint } from "./token/device-fingerprint";
import { TokenService } from "./token/token.service";

class SamlCallbackDto {
  SAMLResponse!: string;
  RelayState!: string; // carries tenantId — round-tripped through the IdP, standard SAML usage of RelayState
}

class RefreshTokenDto {
  refresh_token!: string;
}

// Pre-authentication endpoints (no platform JWT exists yet — that's the
// entire point of this exchange) — excluded from TenantContextMiddleware
// in app.module.ts, same as the health endpoints.
@Controller("api/v1/auth")
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly tokenService: TokenService,
  ) {}

  @Post("saml/callback")
  async samlCallback(@Body() body: SamlCallbackDto, @Req() req: Request) {
    if (!body.RelayState) {
      throw new BadRequestException("Missing RelayState (tenant identifier).");
    }
    const callbackUrl = this.callbackUrl(req, "saml/callback");
    const tokens = await this.authService.handleSamlCallback(body.RelayState, body.SAMLResponse, callbackUrl, req.ip ?? null, req.get("user-agent") ?? "");
    return this.tokenResponse(tokens);
  }

  @Get("oidc/callback")
  async oidcCallback(@Query("code") code: string, @Query("state") tenantId: string, @Req() req: Request) {
    if (!tenantId) {
      throw new BadRequestException("Missing state (tenant identifier).");
    }
    const callbackUrl = this.callbackUrl(req, "oidc/callback");
    const tokens = await this.authService.handleOidcCallback(tenantId, code, callbackUrl, req.ip ?? null, req.get("user-agent") ?? "");
    return this.tokenResponse(tokens);
  }

  @Post("token/refresh")
  async refresh(@Body() body: RefreshTokenDto, @Req() req: Request) {
    if (!body.refresh_token) {
      throw new BadRequestException("Missing refresh_token.");
    }
    const deviceFingerprint = computeDeviceFingerprint(req.get("user-agent") ?? "", req.ip ?? "unknown");
    const tokens = await this.tokenService.refreshTokens(body.refresh_token, deviceFingerprint);
    return this.tokenResponse(tokens);
  }

  private tokenResponse(tokens: { accessToken: string; refreshToken: string }) {
    return { access_token: tokens.accessToken, refresh_token: tokens.refreshToken, token_type: "Bearer" };
  }

  private callbackUrl(req: Request, path: string): string {
    return `${req.protocol}://${req.get("host")}/api/v1/auth/${path}`;
  }
}
