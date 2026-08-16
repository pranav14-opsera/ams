import { MiddlewareConsumer, Module, RequestMethod, type NestModule } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module";
import { SessionValidationMiddleware } from "./auth/session/session-validation.middleware";
import { AdaptersModule } from "./adapters/adapters.module";
import { HmacValidationMiddleware } from "./adapters/hmac-validation.middleware";
import { AutoGenModule } from "./adapters/autogen/autogen.module";
import { CrewAiModule } from "./adapters/crewai/crewai.module";
import { AdapterHealthModule } from "./adapters/health/adapter-health.module";
import { LangChainModule } from "./adapters/langchain/langchain.module";
import { RestModule } from "./adapters/rest/rest.module";
import { ClassificationModule } from "./classification/classification.module";
import { DatabaseModule } from "./common/database/database.module";
import { CreditsModule } from "./credits/credits.module";
import { CreditReconciliationModule } from "./credits/reconciliation/credit-reconciliation.module";
import { TenantContextMiddleware } from "./common/tenant-context.middleware";
import { HealthController } from "./health.controller";
import { AgentsModule } from "./agents/agents.module";
import { AlertsModule } from "./alerts/alerts.module";
import { AnomalyDetectionModule } from "./anomaly-detection/anomaly-detection.module";
import { AuditModule } from "./audit/audit.module";
import { DashboardModule } from "./dashboard/dashboard.module";
import { DriftDetectionModule } from "./drift-detection/drift-detection.module";
import { GatewayModule } from "./gateway/gateway.module";
import { PhiScrubberModule } from "./phi-scrubber/phi-scrubber.module";
import { QualityScoreModule } from "./quality-score/quality-score.module";
import { RbacModule } from "./rbac/rbac.module";
import { ScimModule } from "./scim/scim.module";
import { SharedErrorsModule } from "./shared/errors/shared-errors.module";
import { TenantsModule } from "./tenants/tenants.module";
import { WebsocketGatewayModule } from "./websocket-gateway/websocket-gateway.module";

const PRE_AUTH_ROUTES = [
  "health/live",
  "health/ready",
  "health/startup",
  "health/credit-reconciliation",
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

// Adapter telemetry ingestion (WO-034) authenticates via a per-agent HMAC
// shared secret (HmacValidationMiddleware), never a platform JWT — same
// "no user session exists at all for this machine-to-machine call"
// reasoning as SCIM_ROUTES above.
const ADAPTER_TELEMETRY_ROUTES = ["api/v1/adapters/*/telemetry"];

@Module({
  // GatewayModule (WO-027's RateLimiterGuard) is imported BEFORE
  // RbacModule so its APP_GUARD runs first — an over-quota request is
  // rejected before any authorization-check work happens at all.
  // SharedErrorsModule (WO-029) is imported LAST so its catch-all
  // GlobalExceptionFilter only ever sees exceptions no more specific
  // registered filter (RbacForbiddenExceptionFilter, etc.) already
  // handled — NestJS resolves overlapping global filters in
  // registration order, first match wins.
  imports: [
    DatabaseModule,
    ClassificationModule,
    PhiScrubberModule,
    AuthModule,
    TenantsModule,
    AuditModule,
    WebsocketGatewayModule,
    GatewayModule,
    RbacModule,
    ScimModule,
    AgentsModule,
    DashboardModule,
    AlertsModule,
    AnomalyDetectionModule,
    QualityScoreModule,
    DriftDetectionModule,
    CreditsModule,
    CreditReconciliationModule,
    AdaptersModule,
    LangChainModule,
    RestModule,
    CrewAiModule,
    AutoGenModule,
    AdapterHealthModule,
    SharedErrorsModule,
  ],
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
    consumer.apply(TenantContextMiddleware).exclude(...PRE_AUTH_ROUTES, ...SCIM_ROUTES, ...ADAPTER_TELEMETRY_ROUTES).forRoutes("*");
    // Registered as a SEPARATE .apply() (not chained into the one
    // above) so it runs strictly after TenantContextMiddleware for every
    // request — it depends on req.sessionId, which that middleware sets
    // from the JWT's `sid` claim (WO-020).
    consumer.apply(SessionValidationMiddleware).exclude(...PRE_AUTH_ROUTES, ...SCIM_ROUTES, ...ADAPTER_TELEMETRY_ROUTES).forRoutes("*");
    // HMAC (not JWT) authenticates telemetry ingestion — applied only to
    // its own route, unlike the two middlewares above which apply
    // everywhere except their exclusions.
    consumer.apply(HmacValidationMiddleware).forRoutes({ path: "api/v1/adapters/:frameworkType/telemetry", method: RequestMethod.POST });
  }
}
