import { MiddlewareConsumer, Module, type NestModule } from "@nestjs/common";
import { ClassificationModule } from "./classification/classification.module";
import { DatabaseModule } from "./common/database/database.module";
import { JWT_VERIFIER } from "./common/jwt/jwt-verifier.port";
import { Rs256JwtVerifier } from "./common/jwt/rs256-jwt-verifier.service";
import { TenantContextMiddleware } from "./common/tenant-context.middleware";
import { HealthController } from "./health.controller";
import { TenantsModule } from "./tenants/tenants.module";

@Module({
  imports: [DatabaseModule, ClassificationModule, TenantsModule],
  controllers: [HealthController],
  providers: [
    {
      provide: JWT_VERIFIER,
      // The PEM comes from KMS's GetPublicKey against the JWT signing key
      // (infrastructure/terraform/kms/jwt-signing.tf, WO-003) in deployed
      // environments — no AWS connector here to fetch it live, so it's an
      // env var, same connector-gap pattern as the rest of this pipeline.
      useFactory: () => new Rs256JwtVerifier(process.env.JWT_PUBLIC_KEY_PEM ?? ""),
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(TenantContextMiddleware)
      .exclude("health/live", "health/ready")
      .forRoutes("*");
  }
}
