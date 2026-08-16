import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { Kafka, type Producer } from "kafkajs";
import type { DlqEntry } from "./credit-reconciliation.types";

const DEFAULT_TOPIC = "credit.consumption.dlq";

/**
 * Real KafkaJS producer for the credit.consumption.dlq topic — same
 * documented environment gap as every other Kafka producer in this
 * codebase (no reachable broker in this sandbox). Tracks a running
 * in-process count of DLQ publish attempts (`dlqMessageCount`) purely so
 * the health-check endpoint (AC) has a real, honest number to report —
 * NOT a substitute for a genuine Kafka consumer-lag/topic-depth query,
 * which would require a reachable broker's admin API.
 */
@Injectable()
export class CreditConsumptionDlqProducerService implements OnModuleDestroy {
  private readonly logger = new Logger(CreditConsumptionDlqProducerService.name);
  private readonly kafka: Kafka;
  private readonly producer: Producer;
  private readonly topic: string;
  private connectPromise: Promise<void> | null = null;
  private dlqMessageCount = 0;

  constructor() {
    const brokers = (process.env.KAFKA_BROKERS ?? "localhost:9092").split(",").map((b) => b.trim());
    this.topic = process.env.KAFKA_CREDIT_CONSUMPTION_DLQ_TOPIC ?? DEFAULT_TOPIC;
    this.kafka = new Kafka({ clientId: "ams-credit-reconciliation-dlq", brokers, retry: { retries: 1 } });
    this.producer = this.kafka.producer();
  }

  getDlqMessageCount(): number {
    return this.dlqMessageCount;
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

  async publish(entry: DlqEntry): Promise<void> {
    this.dlqMessageCount++;
    await this.ensureConnected();
    await this.producer.send({ topic: this.topic, messages: [{ key: entry.event.tenantId, value: JSON.stringify(entry) }] });
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.producer.disconnect();
    } catch (err) {
      this.logger.warn(`error disconnecting DLQ producer during shutdown: ${err}`);
    }
  }
}
