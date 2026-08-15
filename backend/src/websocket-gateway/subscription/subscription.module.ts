import { Module } from "@nestjs/common";
import { AuthModule } from "../../auth/auth.module";
import { AUDIT_SERVICE } from "../../tenants/ports/audit-service.port";
import { PostgresAuditService } from "../../tenants/ports/postgres/postgres-audit.service";
import { ChannelPermissionsService } from "./channel-permissions.service";
import { KafkaConsumerBridgeService } from "./kafka-consumer-bridge.service";
import { SubscriptionManagerService } from "./subscription-manager.service";
import { SubscriptionRegistryService } from "./subscription-registry.service";

// AUDIT_SERVICE isn't exported from a shared module in this codebase — every
// module that needs it re-provides its own PostgresAuditService binding
// (see audit-retention.module.ts, agents.module.ts, auth.module.ts, etc.).
@Module({
  imports: [AuthModule], // JWT_VERIFIER (SubscriptionManagerService's dependency) is provided there
  providers: [
    SubscriptionRegistryService,
    ChannelPermissionsService,
    { provide: AUDIT_SERVICE, useClass: PostgresAuditService },
    SubscriptionManagerService,
    KafkaConsumerBridgeService,
  ],
  exports: [SubscriptionRegistryService, ChannelPermissionsService, SubscriptionManagerService, KafkaConsumerBridgeService],
})
export class SubscriptionModule {}
