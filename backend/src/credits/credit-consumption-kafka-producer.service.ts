import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { Kafka, type Producer } from "kafkajs";

const DEFAULT_TOPIC = "credit.consumption";

export interface CreditConsumptionEvent {
  /** WO-067's own idempotency key — the reconciliation consumer's credit_processed_events table is keyed by this, not by Kafka offset (offsets aren't stable/comparable across a rebalance the way a caller-assigned UUID is). */
  eventId: string;
  tenantId: string;
  teamId: string | null;
  agentId: string | null;
  actionType: string;
  creditsConsumed: number;
  enforcementMode: "cache" | "ledger";
  decision: "allowed" | "denied";
  occurredAt: string;
}

/**
 * Real KafkaJS producer for the credit.consumption topic (partitioned by
 * tenant_id, acks=all per this WO's own AC). Same class of environment
 * gap as KafkaAuditEventProducerService/KafkaTelemetryProducerService:
 * no reachable Kafka broker in this sandbox, so publish() genuinely
 * fails locally — MeteringEngineService treats this as a best-effort
 * side effect and never lets a publish failure block or slow down the
 * actual allow/deny decision (the AC's own <500ms P95 critical-path
 * requirement would be meaningless if metering decisions waited on
 * Kafka).
 */
@Injectable()
export class CreditConsumptionKafkaProducerService implements OnModuleDestroy {
  private readonly logger = new Logger(CreditConsumptionKafkaProducerService.name);
  private readonly kafka: Kafka;
  private readonly producer: Producer;
  private readonly topic: string;
  private connectPromise: Promise<void> | null = null;

  constructor() {
    const brokers = (process.env.KAFKA_BROKERS ?? "localhost:9092").split(",").map((b) => b.trim());
    this.topic = process.env.KAFKA_CREDIT_CONSUMPTION_TOPIC ?? DEFAULT_TOPIC;
    this.kafka = new Kafka({ clientId: "ams-credit-metering", brokers, retry: { retries: 1 } });
    this.producer = this.kafka.producer();
  }

  private async ensureConnected(): Promise<void> {
    if (!this.connectPromise) {
      this.connectPromise = this.producer.connect().catch((err) => {
        this.connectPromise = null;
        throw err;
      });
    }
    return this.connectPromise;
  }

  async publish(event: CreditConsumptionEvent): Promise<void> {
    await this.ensureConnected();
    await this.producer.send({
      topic: this.topic,
      acks: -1, // AC: "acks=all"
      messages: [{ key: event.tenantId, value: JSON.stringify(event) }],
    });
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.producer.disconnect();
    } catch (err) {
      this.logger.warn(`error disconnecting Kafka producer during shutdown: ${err}`);
    }
  }
}
