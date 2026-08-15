import { Module } from "@nestjs/common";
import { AuthModule } from "../../auth/auth.module";
import { ChannelPermissionsService } from "./channel-permissions.service";
import { KafkaConsumerBridgeService } from "./kafka-consumer-bridge.service";
import { SubscriptionManagerService } from "./subscription-manager.service";
import { SubscriptionRegistryService } from "./subscription-registry.service";

@Module({
  imports: [AuthModule], // JWT_VERIFIER (SubscriptionManagerService's dependency) is provided there
  providers: [SubscriptionRegistryService, ChannelPermissionsService, SubscriptionManagerService, KafkaConsumerBridgeService],
  exports: [SubscriptionRegistryService, ChannelPermissionsService, SubscriptionManagerService, KafkaConsumerBridgeService],
})
export class SubscriptionModule {}
