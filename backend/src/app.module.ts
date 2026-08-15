import { MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module";
import { SessionValidationMiddleware } from "./auth/session/session-validation.middleware";
import { ClassificationModule } from "./classification/classification.module";
import { DatabaseModule } from "./common/database/database.module";
import { TenantContextMiddleware } from "./common/tenant-context.middleware";
import { HealthController } from "./health.controller";
import { GatewayModule } from "./gateway/gateway.module";
import { PhiScrubberModule } from "./phi-scrubber/phi-scrubber.module";
import { RbacModule } from "./rbac/rbac.module";
import { ScimModule } from "./scim/scim.module";
import { SharedErrorsModule } from "./shared/errors/shared-errors.module";
import { TenantsModule } from "./tenants/tenants.module";

const PRE_AUTH_ROUTES = [
  "health/live",
  "health/ready",
  "health/startup",
  "metrics",
  "api/v1/auth/saml/callback",
  "api/v1/auth/oidc/callback",
  "api/v1/auth/token/refresh",
  "api/v1/auth/.well-known/jwks.json",
];

// SCIM (WO-025) authenticates with its own tenant-scoped bearer token
// (ScimAuthGuard), never a platform JWT — excluded from
// TenantContextMiddleware/SessionValidationMiddleware for the same
// reason PRE_AUTH_ROUTES is: no JWT necessarily exists at all for a
// machine-to-machine SCIM call.
const SCIM_ROUTES = ["scim/v2/Users", "scim/v2/Users/*", "scim/v2/Groups", "scim/v2/Groups/*"];

@Module({
  // GatewayModule (WO-027's RateLimiterGuard) is imported BEFORE
  // RbacModule so its APP_GUARD runs first — an over-quota request is
  // rejected before any authorization-check work happens at all.
  // SharedErrorsModule (WO-029) is imported LAST so its catch-all
  // GlobalExceptionFilter only ever sees exceptions no more specific
  // registered filter (RbacForbiddenExceptionFilter, etc.) already
  // handled — NestJS resolves overlapping global filters in
  // registration order, first match wins.
  imports: [DatabaseModule, ClassificationModule, PhiScrubberModule, AuthModule, TenantsModule, GatewayModule, RbacModule, ScimModule, SharedErrorsModule],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // saml/callback, oidc/callback, and token/refresh are all
    // pre-authentication (or authenticate via something other than a
    // platform access token — a refresh token, in the last case) — no
    // valid platform JWT necessarily exists yet at the point the caller
    // hits any of these, that's the entire purpose of each exchange.
    // jwks.json is a public key set, deliberately fetchable without any
    // token at all.
    consumer.apply(TenantContextMiddleware).exclude(...PRE_AUTH_ROUTES, ...SCIM_ROUTES).forRoutes("*");
    // Registered as a SEPARATE .apply() (not chained into the one
    // above) so it runs strictly after TenantContextMiddleware for every
    // request — it depends on req.sessionId, which that middleware sets
    // from the JWT's `sid` claim (WO-020).
    consumer.apply(SessionValidationMiddleware).exclude(...PRE_AUTH_ROUTES, ...SCIM_ROUTES).forRoutes("*");
  }
}
