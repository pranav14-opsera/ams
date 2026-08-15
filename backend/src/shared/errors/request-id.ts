import { randomUUID } from "node:crypto";
import type { Request } from "express";

/**
 * The ONE place every error/denial path in this codebase gets its
 * request_id from — so it actually matches the X-Request-ID header the
 * gateway (WO-026) generates and forwards, per this WO's own
 * acceptance criteria. Before this, RbacGuard and the rate limiter each
 * generated their OWN fresh UUID independently, meaning a client's
 * X-Request-ID never actually correlated with what came back in a 403.
 */
export function getRequestId(req: Request): string {
  const header = req.headers?.["x-request-id"];
  if (typeof header === "string" && header.length > 0) return header;
  if (Array.isArray(header) && header[0]) return header[0];
  return randomUUID();
}
