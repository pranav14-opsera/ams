import { MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module";
import { ClassificationModule } from "./classification/classification.module";
import { DatabaseModule } from "./common/database/database.module";
import { TenantContextMiddleware } from "./common/tenant-context.middleware";
import { HealthController } from "./health.controller";
import { PhiScrubberModule } from "./phi-scrubber/phi-scrubber.module";
import { TenantsModule } from "./tenants/tenants.module";

@Module({
  imports: [DatabaseModule, ClassificationModule, PhiScrubberModule, AuthModule, TenantsModule],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(TenantContextMiddleware)
      // saml/callback, oidc/callback, and token/refresh are all
      // pre-authentication (or authenticate via something other than a
      // platform access token — a refresh token, in the last case) — no
      // valid platform JWT necessarily exists yet at the point the
      // caller hits any of these, that's the entire purpose of each
      // exchange. jwks.json is a public key set, deliberately fetchable
      // without any token at all (WO-019).
      .exclude(
        "health/live",
        "health/ready",
        "api/v1/auth/saml/callback",
        "api/v1/auth/oidc/callback",
        "api/v1/auth/token/refresh",
        "api/v1/auth/.well-known/jwks.json",
      )
      .forRoutes("*");
  }
}
