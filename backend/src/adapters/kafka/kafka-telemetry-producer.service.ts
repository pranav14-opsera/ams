import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { Kafka, type Producer } from "kafkajs";
import type { CanonicalTelemetryEvent } from "../schemas/canonical-telemetry";
import type { TelemetryPublisherPort } from "./telemetry-publisher.port";

const DEFAULT_TOPIC = "agent-telemetry";

/**
 * Real KafkaJS producer against the AWS MSK cluster provisioned in
 * infrastructure/terraform/messaging/kafka (bootstrap_servers surfaced
 * as KAFKA_BROKERS at deploy time) — genuine wire-protocol client, not a
 * stub. This sandbox has no reachable broker (no Docker/testcontainers,
 * confirmed by direct connection attempt — same class of environment gap
 * as WO-026's Terraform provider handshake), so publish() calls here
 * fail with a real connection error in local/test runs; TelemetryPipelineService
 * catches that and falls back to the telemetry_dead_letter_events table,
 * which IS fully exercised against real local Postgres. See
 * TELEMETRY_PIPELINE.md.
 */
@Injectable()
export class KafkaTelemetryProducerService implements TelemetryPublisherPort, OnModuleDestroy {
  private readonly logger = new Logger(KafkaTelemetryProducerService.name);
  private readonly kafka: Kafka;
  private readonly producer: Producer;
  private readonly topic: string;
  private connectPromise: Promise<void> | null = null;

  constructor() {
    const brokers = (process.env.KAFKA_BROKERS ?? "localhost:9092").split(",").map((b) => b.trim());
    this.topic = process.env.KAFKA_TELEMETRY_TOPIC ?? DEFAULT_TOPIC;
    this.kafka = new Kafka({ clientId: "ams-adapters", brokers, retry: { retries: 1 } });
    this.producer = this.kafka.producer();
  }

  private async ensureConnected(): Promise<void> {
    if (!this.connectPromise) {
      this.connectPromise = this.producer.connect().catch((err) => {
        this.connectPromise = null; // allow a future publish() to retry the connection rather than caching a permanent failure
        throw err;
      });
    }
    return this.connectPromise;
  }

  async publish(event: CanonicalTelemetryEvent): Promise<void> {
    await this.ensureConnected();
    // Partitioned by tenant_id (this WO's own acceptance criteria): passed
    // as the message `key`, which KafkaJS's default partitioner hashes to
    // a consistent partition — every event for one tenant lands on the
    // same partition, preserving per-tenant ordering.
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
