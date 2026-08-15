import { createHmac, timingSafeEqual } from "node:crypto";
import { Injectable, Logger, type NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { AgentsRepository } from "../agents/agents.repository";
import { EncryptionService } from "../encryption/encryption.service";

declare module "express-serve-static-core" {
  interface Request {
    /** Set by HmacValidationMiddleware once signature verification succeeds — the agent this telemetry request authenticated as. */
    telemetryAgentId?: string;
    /** Populated by Nest when NestFactory.create(AppModule, { rawBody: true }) — the exact raw request bytes, needed since HMAC must verify over what the caller actually signed, not a re-serialization of the parsed JSON body. */
    rawBody?: Buffer;
  }
}

const SIGNATURE_HEADER = "x-signature-256";
const AGENT_ID_HEADER = "x-agent-id";
const GENERIC_AUTH_FAILURE = { error: "unauthorized", message: "Authentication failed" };

/**
 * Authenticates POST /api/v1/adapters/*​/telemetry requests via a
 * per-agent HMAC-SHA256 shared secret (WO-034) instead of a platform JWT
 * — there is no user session at all for a machine-to-machine telemetry
 * submission. Deliberately generic on every failure path (missing
 * headers, unknown agent, bad signature all return the exact same 401
 * body) — this WO's own acceptance criteria: "no information leakage
 * about the expected signature."
 */
@Injectable()
export class HmacValidationMiddleware implements NestMiddleware {
  private readonly logger = new Logger(HmacValidationMiddleware.name);

  constructor(
    private readonly agentsRepository: AgentsRepository,
    private readonly encryptionService: EncryptionService,
  ) {}

  async use(req: Request, res: Response, next: NextFunction): Promise<void> {
    const signatureHeader = req.headers[SIGNATURE_HEADER];
    const agentId = req.headers[AGENT_ID_HEADER];

    if (typeof signatureHeader !== "string" || typeof agentId !== "string") {
      this.logger.warn(`security event: telemetry request missing ${SIGNATURE_HEADER}/${AGENT_ID_HEADER} — ${req.method} ${req.originalUrl}`);
      res.status(401).json(GENERIC_AUTH_FAILURE);
      return;
    }

    const agent = await this.agentsRepository.findByIdAcrossTenants(undefined, agentId);
    if (!agent) {
      this.logger.warn(`security event: telemetry request for unknown agent_id (${agentId}) — ${req.method} ${req.originalUrl}`);
      res.status(401).json(GENERIC_AUTH_FAILURE);
      return;
    }

    const secret = await this.encryptionService.decrypt(agent.tenant_id, {
      ciphertext: agent.hmac_secret_ciphertext,
      iv: agent.hmac_secret_iv,
      authTag: agent.hmac_secret_auth_tag,
      encryptedDataKey: agent.hmac_secret_encrypted_dek,
      keyVersion: agent.hmac_secret_key_version,
    });

    // req.rawBody requires NestFactory.create(AppModule, { rawBody: true })
    // (main.ts) — HMAC must be computed over the EXACT bytes the caller
    // signed, not a re-serialization of the parsed JSON body (which can
    // differ in key order/whitespace and would make every legitimately
    // signed request fail verification).
    const rawBody = req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
    const expectedSignature = createHmac("sha256", secret).update(rawBody).digest("hex");

    // "sha256=<hex>" (GitHub-webhook-style prefix) is accepted in
    // addition to a bare hex digest — both forms are equally valid, this
    // just strips the prefix before comparing.
    const providedSignature = signatureHeader.startsWith("sha256=") ? signatureHeader.slice("sha256=".length) : signatureHeader;

    if (!this.signaturesMatch(expectedSignature, providedSignature)) {
      this.logger.warn(`security event: telemetry HMAC signature verification failed for agent ${agentId} — ${req.method} ${req.originalUrl}`);
      res.status(401).json(GENERIC_AUTH_FAILURE);
      return;
    }

    req.telemetryAgentId = agent.id;
    req.tenantId = agent.tenant_id;
    next();
  }

  private signaturesMatch(expectedHex: string, providedHex: string): boolean {
    // timingSafeEqual throws on mismatched buffer lengths rather than
    // returning false — an attacker-controlled (wrong-length) signature
    // header must not be able to trigger a 500 that behaves differently
    // from a normal 401, so length is checked explicitly first.
    if (expectedHex.length !== providedHex.length) return false;
    try {
      return timingSafeEqual(Buffer.from(expectedHex, "hex"), Buffer.from(providedHex, "hex"));
    } catch {
      return false; // providedHex wasn't valid hex at all
    }
  }
}
