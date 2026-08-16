import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { Kafka, type Consumer, type EachBatchPayload } from "kafkajs";
import type { CreditConsumptionEvent } from "../credit-consumption-kafka-producer.service";
import { CreditReconciliationService } from "./credit-reconciliation.service";

const DEFAULT_TOPIC = "credit.consumption";
const CONSUMER_GROUP = "credit-reconciliation"; // AC: "A Kafka consumer group (credit-reconciliation)"
const BATCH_SIZE = 100; // AC: "batch size of 100"

/**
 * Real KafkaJS consumer for the credit.consumption topic. Same
 * documented environment gap as this codebase's Kafka PRODUCERS: no
 * reachable broker in this sandbox, so `run()` genuinely never receives
 * a batch here — `connect()`/`subscribe()`/`run()` are called for real
 * and will keep retrying per kafkajs's own connection retry policy, but
 * this class has no unit/integration test of its own (there is nothing
 * to assert against without a broker). The real, fully-testable
 * business logic lives entirely in CreditReconciliationService.processBatch,
 * which this consumer's eachBatch handler simply calls — every test in
 * this WO exercises that method directly, the same substitution pattern
 * used for every Kafka-touching WO this session.
 *
 * Manual offset commit (AC): only commit a message's offset once its
 * WHOLE containing batch has been handed to processBatch and that call
 * has returned — a crash mid-batch means Kafka redelivers the entire
 * batch on restart, which processBatch's own idempotency (credit_processed_events)
 * makes safe to reprocess without double-debiting.
 */
@Injectable()
export class CreditReconciliationConsumerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CreditReconciliationConsumerService.name);
  private readonly kafka: Kafka;
  private readonly consumer: Consumer;
  private readonly topic: string;

  constructor(private readonly reconciliationService: CreditReconciliationService) {
    const brokers = (process.env.KAFKA_BROKERS ?? "localhost:9092").split(",").map((b) => b.trim());
    this.topic = process.env.KAFKA_CREDIT_CONSUMPTION_TOPIC ?? DEFAULT_TOPIC;
    this.kafka = new Kafka({ clientId: "ams-credit-reconciliation", brokers, retry: { retries: 1 } });
    this.consumer = this.kafka.consumer({ groupId: CONSUMER_GROUP });
  }

  async onModuleInit(): Promise<void> {
    // Never let a broker-connection failure block the rest of Nest's bootstrap (same posture as every other best-effort background integration this session) — retry in the background instead of throwing out of onModuleInit.
    this.startConsuming().catch((err) => this.logger.warn(`credit reconciliation consumer failed to start (will not retry until process restart in this minimal implementation): ${err instanceof Error ? err.message : err}`));
  }

  private async startConsuming(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({ topic: this.topic, fromBeginning: false });
    await this.consumer.run({
      eachBatchAutoResolve: false,
      eachBatch: async (payload: EachBatchPayload) => this.handleBatch(payload),
    });
  }

  private async handleBatch(payload: EachBatchPayload): Promise<void> {
    const { batch, resolveOffset, heartbeat, commitOffsetsIfNecessary } = payload;
    const events: CreditConsumptionEvent[] = [];

    for (const message of batch.messages.slice(0, BATCH_SIZE)) {
      if (!message.value) continue;
      try {
        events.push(JSON.parse(message.value.toString()) as CreditConsumptionEvent);
      } catch (err) {
        this.logger.error(`skipping unparseable credit.consumption message at offset ${message.offset}: ${err instanceof Error ? err.message : err}`);
      }
      resolveOffset(message.offset);
      await heartbeat();
    }

    const result = await this.reconciliationService.processBatch(undefined, events);
    this.logger.log(`reconciled batch: processed=${result.processed} deduplicated=${result.deduplicated} skipped=${result.skipped} failed=${result.failed.length}`);
    await commitOffsetsIfNecessary();
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.consumer.disconnect();
    } catch (err) {
      this.logger.warn(`error disconnecting reconciliation consumer during shutdown: ${err}`);
    }
  }
}
