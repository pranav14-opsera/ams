import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from "@nestjs/common";
import type { Request, Response } from "express";
import type { Pool } from "pg";
import { PG_POOL } from "../common/database/database.module";
import { scimUnauthorized } from "./scim-error";
import { ScimTokenRepository } from "./scim-token.repository";

declare module "express-serve-static-core" {
  interface Request {
    scimTokenId?: string;
  }
}

/**
 * SCIM's own authentication scheme (RFC 7644 §2: a static, tenant-scoped
 * bearer token the IdP presents on every call) — deliberately independent
 * of the platform's JWT/session auth. Establishes the same
 * app.current_tenant RLS context TenantContextMiddleware sets for JWT
 * requests, just derived from the SCIM token instead. scim/v2/* routes
 * are excluded from TenantContextMiddleware entirely (app.module.ts) —
 * this guard is the only thing that runs for them.
 */
@Injectable()
export class ScimAuthGuard implements CanActivate {
  private readonly logger = new Logger(ScimAuthGuard.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly tokenRepository: ScimTokenRepository,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();

    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;
    if (!token) {
      throw scimUnauthorized("Missing SCIM bearer token.");
    }

    const tokenRecord = await this.tokenRepository.findByRawToken(this.pool, token);
    if (!tokenRecord) {
      this.logger.warn(`security event: SCIM request with an invalid/revoked token — ${req.method} ${req.originalUrl}`);
      throw scimUnauthorized("Invalid or revoked SCIM token.");
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [tokenRecord.tenantId]);
    } catch (err) {
      client.release();
      throw err;
    }

    req.tenantDbClient = client;
    req.tenantId = tokenRecord.tenantId;
    req.scimTokenId = tokenRecord.id;

    res.on("finish", () => {
      const commitOrRollback = res.statusCode >= 500 ? "ROLLBACK" : "COMMIT";
      client
        .query(commitOrRollback)
        .catch((err) => this.logger.error(`failed to ${commitOrRollback} SCIM request-scoped transaction: ${err}`))
        .finally(() => client.release());
    });

    return true;
  }
}
