import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { AdapterConfigurationRepository } from "./adapter-configuration.repository";
import { AdapterHealthService } from "./adapter-health.service";

const TICK_INTERVAL_MS = 10_000;
const MAX_JITTER_MS = 5_000; // AC: "random delay 0-5s ... to prevent thundering herd"

/**
 * Runs each adapter's health probe at its own configurable interval
 * (default 60s, adapter_configurations.health_check_interval_seconds) —
 * a single tick (every 10s) checks which adapters are due and fires
 * their probe with a random 0-5s jitter, rather than one setInterval per
 * adapter racing every probe at the exact same instant.
 */
@Injectable()
export class AdapterHealthSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AdapterHealthSchedulerService.name);
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly healthService: AdapterHealthService,
    private readonly configRepository: AdapterConfigurationRepository,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.logger.warn(`adapter health scheduler tick failed: ${err}`));
    }, TICK_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    const configs = await this.configRepository.findAll();
    const now = Date.now();

    for (const config of configs) {
      const dueAt = config.last_health_check_at ? new Date(config.last_health_check_at).getTime() + config.health_check_interval_seconds * 1000 : 0;
      if (now < dueAt) continue;

      const jitterMs = Math.floor(Math.random() * MAX_JITTER_MS);
      setTimeout(() => {
        this.healthService.runHealthProbe(config.adapter_type).catch((err) => this.logger.warn(`health probe failed for ${config.adapter_type}: ${err}`));
      }, jitterMs);
    }
  }
}
