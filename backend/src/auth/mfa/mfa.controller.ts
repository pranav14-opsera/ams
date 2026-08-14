import { Body, Controller, Inject, Post, Req, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import type { Pool } from "pg";
import { PG_POOL } from "../../common/database/database.module";
import { NoPermissionRequired } from "../../rbac/no-permission-required.decorator";
import { VerifyMfaDto } from "./dto/verify-mfa.dto";
import { MfaService } from "./mfa.service";

// Self-service: a user enrolling/verifying their OWN MFA is not gated by
// the WO-023 permission matrix — every authenticated user regardless of
// role must be able to do this for themselves.
@Controller("api/v1/auth/mfa")
export class MfaController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly mfaService: MfaService,
  ) {}

  @Post("enroll")
  @NoPermissionRequired()
  async enroll(@Req() req: Request) {
    this.requireAuthenticated(req);
    const email = await this.lookupUserEmail(req.actorId!);
    return this.mfaService.enroll(req.actorId!, req.tenantId!, email);
  }

  @Post("verify")
  @NoPermissionRequired()
  async verify(@Body() dto: VerifyMfaDto, @Req() req: Request) {
    this.requireAuthenticated(req);
    if (!req.sessionId) {
      throw new UnauthorizedException("No active session to elevate.");
    }
    await this.mfaService.verify(req.actorId!, req.tenantId!, req.sessionId, dto.code);
    return { verified: true };
  }

  private requireAuthenticated(req: Request): void {
    if (!req.actorId || !req.tenantId) {
      throw new UnauthorizedException("Authentication required.");
    }
  }

  private async lookupUserEmail(userId: string): Promise<string> {
    const result = await this.pool.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [userId]);
    return result.rows[0]?.email ?? userId;
  }
}
