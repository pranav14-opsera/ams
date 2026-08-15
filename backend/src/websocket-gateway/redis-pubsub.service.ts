import { Injectable, OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";

type MessageHandler = (message: unknown) => void;

function tenantChannel(tenantId: string, channel: string): string {
  return `ws:${channel}:${tenantId}`;
}

/**
 * Cross-instance message routing: publishing and subscribing need
 * SEPARATE ioredis connections — once a connection issues SUBSCRIBE it
 * can only issue further (p)(un)subscribe commands, nothing else
 * (ioredis enforces this), so a single shared client can't do both.
 */
@Injectable()
export class RedisPubSubService implements OnModuleDestroy {
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private readonly handlers = new Map<string, Set<MessageHandler>>();

  constructor() {
    const url = process.env.REDIS_URL ?? "redis://localhost:6379";
    this.publisher = new Redis(url, { maxRetriesPerRequest: 1 });
    this.subscriber = new Redis(url, { maxRetriesPerRequest: 1 });
    this.publisher.on("error", () => undefined);
    this.subscriber.on("error", () => undefined);

    this.subscriber.on("message", (channel: string, raw: string) => {
      const handlers = this.handlers.get(channel);
      if (!handlers) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      for (const handler of handlers) handler(parsed);
    });
  }

  async publish(tenantId: string, channel: string, message: unknown): Promise<void> {
    await this.publisher.publish(tenantChannel(tenantId, channel), JSON.stringify(message));
  }

  async subscribe(tenantId: string, channel: string, handler: MessageHandler): Promise<void> {
    const key = tenantChannel(tenantId, channel);
    const existing = this.handlers.get(key);
    if (existing) {
      existing.add(handler);
      return; // already subscribed to this channel — just add the handler
    }

    this.handlers.set(key, new Set([handler]));
    await this.subscriber.subscribe(key);
  }

  async unsubscribe(tenantId: string, channel: string, handler: MessageHandler): Promise<void> {
    const key = tenantChannel(tenantId, channel);
    const handlers = this.handlers.get(key);
    if (!handlers) return;

    handlers.delete(handler);
    if (handlers.size === 0) {
      this.handlers.delete(key);
      await this.subscriber.unsubscribe(key);
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const client of [this.publisher, this.subscriber]) {
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    }
  }
}
