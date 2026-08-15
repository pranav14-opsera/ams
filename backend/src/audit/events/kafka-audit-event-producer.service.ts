import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { Kafka, type Producer } from "kafkajs";
import type { CanonicalAuditEvent } from "./canonical-audit-event";
import type { AuditEventPublisherPort } from "./audit-event-publisher.port";

const DEFAULT_TOPIC = "audit-events";

/**
 * Real KafkaJS producer for the audit-events topic (partitioned by
 * tenant_id, replication factor 3 in the real deployment topology — see
 * AUDIT_ENRICHMENT_PIPELINE.md; this class only produces, it doesn't
 * create topics). Same class of environment gap as
 * KafkaTelemetryProducerService (WO-034): no reachable Kafka broker in
 * this sandbox (confirmed by direct connection probe), so publish() here
 * genuinely fails in local/test runs and AuditEventProducerService falls
 * back to its own in-memory buffer, ultimately reaching
 * audit_events_dlq if that buffer is also exhausted — both fully
 * exercised against real Postgres.
 */
@Injectable()
export class KafkaAuditEventProducerService implements AuditEventPublisherPort, OnModuleDestroy {
  private readonly logger = new Logger(KafkaAuditEventProducerService.name);
  private readonly kafka: Kafka;
  private readonly producer: Producer;
  private readonly topic: string;
  private connectPromise: Promise<void> | null = null;

  constructor() {
    const brokers = (process.env.KAFKA_BROKERS ?? "localhost:9092").split(",").map((b) => b.trim());
    this.topic = process.env.KAFKA_AUDIT_EVENTS_TOPIC ?? DEFAULT_TOPIC;
    this.kafka = new Kafka({ clientId: "ams-audit", brokers, retry: { retries: 1 } });
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

  async publish(event: CanonicalAuditEvent): Promise<void> {
    await this.ensureConnected();
    await this.producer.send({
      topic: this.topic,
      messages: [{ key: event.tenant_id, value: JSON.stringify(event) }],
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
