import { Inject, Injectable, Logger, type NestMiddleware } from "@nestjs/common";
import type { Request, Response, NextFunction } from "express";
import type { Pool, PoolClient } from "pg";
import { PG_POOL } from "./database/database.module";
import { JWT_VERIFIER, JwtVerificationError, type JwtVerifierPort } from "./jwt/jwt-verifier.port";

declare module "express-serve-static-core" {
  interface Request {
    /** Pool client checked out for this request, with app.current_tenant already set. Released after the response finishes. */
    tenantDbClient?: PoolClient;
    tenantId?: string;
    actorId?: string;
    /** The `sid` claim (WO-019/020) — undefined for a token minted before session support existed, or one that genuinely has no session (there is none today; every token issuance goes through TokenService, which always creates one). */
    sessionId?: string;
  }
}

// Extracts tenant_id from the validated JWT and sets the PostgreSQL
// session variable app.current_tenant on the connection this request
// will use for every query — the enforcement point RLS (WO-004,
// database/migrations/006_enable_rls.sql) depends on. Session variables
// are per-CONNECTION, not global, and pg's Pool reuses connections across
// requests — so this checks a client out of the pool for the lifetime of
// this one request (not the pool's 'connect' event, which only fires for
// brand-new physical connections, not every logical checkout) and
// attaches it to the request so downstream repositories reuse the exact
// same connection rather than getting a different one with no tenant set.
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantContextMiddleware.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(JWT_VERIFIER) private readonly jwtVerifier: JwtVerifierPort,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : undefined;

    if (!token) {
      this.logger.warn(`security event: missing Authorization header — ${req.method} ${req.originalUrl}`);
      res.status(401).json({ error: "unauthorized", message: "missing bearer token" });
      return;
    }

    let claims;
    try {
      claims = await this.jwtVerifier.verify(token);
    } catch (err) {
      const reason = err instanceof JwtVerificationError ? err.message : "verification failed";
      this.logger.warn(`security event: JWT verification failed (${reason}) — ${req.method} ${req.originalUrl}`);
      res.status(401).json({ error: "unauthorized", message: "invalid token" });
      return;
    }

    if (!claims.tenant_id) {
      this.logger.warn(`security event: JWT missing tenant_id claim — ${req.method} ${req.originalUrl}`);
      res.status(401).json({ error: "unauthorized", message: "token missing tenant_id" });
      return;
    }

    const client = await this.pool.connect();
    try {
      const tenantResult = await client.query<{ is_active: boolean }>("SELECT is_active FROM tenants WHERE id = $1", [claims.tenant_id]);
      if (tenantResult.rowCount === 0 || !tenantResult.rows[0].is_active) {
        this.logger.warn(`security event: JWT references an inactive/unknown tenant (${claims.tenant_id}) — ${req.method} ${req.originalUrl}`);
        client.release();
        res.status(401).json({ error: "unauthorized", message: "tenant is not active" });
        return;
      }

      await client.query("BEGIN");
      // set_config's third argument (is_local=true) scopes this to the
      // current transaction, same as SET LOCAL — but as a real query
      // parameter, so a tenant_id containing SQL-meaningful characters
      // can't do anything (it can't, it's a UUID, but the pattern matters
      // more than this specific value ever being dangerous).
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [claims.tenant_id]);
    } catch (err) {
      client.release();
      next(err);
      return;
    }

    req.tenantDbClient = client;
    req.tenantId = claims.tenant_id;
    req.actorId = claims.sub;
    req.sessionId = typeof claims.sid === "string" ? claims.sid : undefined;

    res.on("finish", () => {
      const commitOrRollback = res.statusCode >= 500 ? "ROLLBACK" : "COMMIT";
      client
        .query(commitOrRollback)
        .catch((err) => this.logger.error(`failed to ${commitOrRollback} request-scoped transaction: ${err}`))
        .finally(() => client.release());
    });

    next();
  }
}
