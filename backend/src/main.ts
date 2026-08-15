import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import helmet from "helmet";
import { AppModule } from "./app.module";
import { CONTENT_SECURITY_POLICY_DIRECTIVES } from "./gateway/csp-policy";
import { PhiMaskingLogger } from "./phi-scrubber/phi-masking.middleware";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // Replaces Nest's own logger globally — every framework-internal and
  // application log call goes through PHI scrubbing, not just ones a
  // developer remembers to route through it explicitly (WO-017).
  app.useLogger(app.get(PhiMaskingLogger));
  // WO-028: mandatory security headers on every response — defense in
  // depth alongside the WAF/security-header config on the NGINX gateway
  // itself (infrastructure/terraform/kubernetes/gateway.tf).
  app.use(
    helmet({
      contentSecurityPolicy: { directives: CONTENT_SECURITY_POLICY_DIRECTIVES },
      hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
      frameguard: { action: "deny" },
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
      // Deliberately restrictive: this API has no legitimate use for any
      // of these browser features itself (only a frontend document would).
      permittedCrossDomainPolicies: { permittedPolicies: "none" },
    }),
  );
  // helmet dropped its own Permissions-Policy middleware (v7+) —
  // deliberately restrictive: this JSON API has no legitimate use for
  // any of these browser features itself.
  app.use((_req: unknown, res: { setHeader: (name: string, value: string) => void }, next: () => void) => {
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    next();
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port);
}

bootstrap();
