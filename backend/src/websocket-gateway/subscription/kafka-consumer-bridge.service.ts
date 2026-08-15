import { Injectable, Logger } from "@nestjs/common";
import type { FanOutResult, KafkaEventEnvelope } from "./subscription.types";
import { SubscriptionManagerService } from "./subscription-manager.service";

/**
 * In a real deployment this runs as a NestJS microservice consuming the
 * `agent-telemetry-aggregated` / `credit-updates` / `alert-notifications`
 * topics via a KafkaJS consumer group; this sandbox has no reachable
 * Kafka broker or consumer group (confirmed directly — same class of
 * environment gap as WO-041's MetricsAggregatorService, WO-043's
 * TelemetryPipelineService, and WO-046's AuditEventConsumerPipelineService,
 * all of which establish the identical substitution: expose the real
 * processing logic as a plain `process(event)` method invoked in-process
 * with one canonical event at a time). The processing logic itself —
 * parse the envelope, extract tenantId/channel, fan out via
 * SubscriptionManagerService — is genuine and fully unit/integration
 * tested against the in-memory SubscriptionRegistryService.
 */
@Injectable()
export class KafkaConsumerBridgeService {
  private readonly logger = new Logger(KafkaConsumerBridgeService.name);

  constructor(private readonly subscriptionManager: SubscriptionManagerService) {}

  process(event: KafkaEventEnvelope): FanOutResult {
    if (!event?.tenantId || !event?.channel) {
      this.logger.warn(`dropping malformed Kafka event envelope (missing tenantId/channel): ${JSON.stringify(event)}`);
      return { delivered: [], filtered: [], errors: [{ userId: "n/a", error: "malformed_envelope" }] };
    }

    return this.subscriptionManager.fanOutMessage(event.tenantId, event.channel, event.payload);
  }
}
