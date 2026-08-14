import { Body, Controller, Inject, Post, Req, UnauthorizedException } from "@nestjs/common";
import type { Request } from "express";
import type { Pool } from "pg";
import { PG_POOL } from "../../common/database/database.module";
import { VerifyMfaDto } from "./dto/verify-mfa.dto";
import { MfaService } from "./mfa.service";

@Controller("api/v1/auth/mfa")
export class MfaController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly mfaService: MfaService,
  ) {}

  @Post("enroll")
  async enroll(@Req() req: Request) {
    this.requireAuthenticated(req);
    const email = await this.lookupUserEmail(req.actorId!);
    return this.mfaService.enroll(req.actorId!, req.tenantId!, email);
  }

  @Post("verify")
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
