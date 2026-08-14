import { Injectable, Logger, UnauthorizedException, type NestMiddleware } from "@nestjs/common";
import type { Request, Response, NextFunction } from "express";
import { SessionService } from "./session.service";

// Registered AFTER TenantContextMiddleware (app.module.ts) — depends on
// req.sessionId, which that middleware sets from the JWT's `sid` claim.
// Enforces idle/absolute session timeout on every authenticated request,
// per this WO's acceptance criteria — the JWT's own 15-minute expiry
// (WO-019) is a separate, shorter-lived control; this is what actually
// implements "automatic logoff" and "force-logout"/SCIM-deprovisioning
// taking effect immediately, since a still-unexpired access token whose
// SESSION has been invalidated must still be rejected.
@Injectable()
export class SessionValidationMiddleware implements NestMiddleware {
  private readonly logger = new Logger(SessionValidationMiddleware.name);

  constructor(private readonly sessionService: SessionService) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!req.sessionId) {
      // No `sid` claim on this token — every token TokenService issues
      // has one, so this only happens for a token minted a different
      // way. Pass through rather than fail closed on an absent feature;
      // TenantContextMiddleware's own checks already gated this request.
      next();
      return;
    }

    try {
      await this.sessionService.validateSession(req.sessionId);
    } catch (err) {
      if (err instanceof UnauthorizedException) {
        this.logger.warn(`security event: session invalid/expired (${req.sessionId}) — ${req.method} ${req.originalUrl}`);
        res.status(401).json({ error: "unauthorized", message: "session has expired" });
        return;
      }
      next(err);
      return;
    }

    next();
  }
}
