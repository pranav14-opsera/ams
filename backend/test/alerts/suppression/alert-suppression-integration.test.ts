import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { MetricsAggregatorRepository } from "../../../src/adapters/metrics/metrics-aggregator.repository";
import { MetricsAggregatorService } from "../../../src/adapters/metrics/metrics-aggregator.service";
import { TelemetryEventType, type CanonicalTelemetryEvent } from "../../../src/adapters/schemas/canonical-telemetry";
import { AlertDeliveryLogRepository } from "../../../src/alerts/alert-delivery-log.repository";
import { AlertDeliveryService } from "../../../src/alerts/alert-delivery.service";
import { AlertEventRepository } from "../../../src/alerts/alert-event.repository";
import { AlertThresholdRepository } from "../../../src/alerts/alert-threshold.repository";
import { ChannelConfigCacheService } from "../../../src/alerts/channel-config-cache.service";
import { EmailAlertChannelService } from "../../../src/alerts/channels/email-alert-channel.service";
import { WebhookAlertChannelService } from "../../../src/alerts/channels/webhook-alert-channel.service";
import { WebSocketAlertChannelService } from "../../../src/alerts/channels/websocket-alert-channel.service";
import { EmailChannelConfigRepository } from "../../../src/alerts/email-channel-config.repository";
import { MetricSnapshotCacheService } from "../../../src/alerts/metric-snapshot-cache.service";
import { InMemoryEmailProviderService } from "../../../src/alerts/ports/in-memory/in-memory-email-provider.service";
import { AlertAutoTuneStateRepository } from "../../../src/alerts/suppression/alert-auto-tune-state.repository";
import { AlertFeedbackService } from "../../../src/alerts/suppression/alert-feedback.service";
import { AlertSnoozeRepository } from "../../../src/alerts/suppression/alert-snooze.repository";
import { AlertSuppressionService } from "../../../src/alerts/suppression/alert-suppression.service";
import { AutoTuneSchedulerService } from "../../../src/alerts/suppression/auto-tune.scheduler.service";
import { FalsePositiveFeedbackRepository } from "../../../src/alerts/suppression/false-positive-feedback.repository";
import { ThresholdEvaluatorService } from "../../../src/alerts/threshold-evaluator.service";
import { WebhookConfigRepository } from "../../../src/alerts/webhook-config.repository";
import { PhiScrubberService } from "../../../src/phi-scrubber/phi-scrubber.service";
import { AgentsRepository } from "../../../src/agents/agents.repository";
import { AgentsService } from "../../../src/agents/agents.service";
import { HealthDashboardRepository } from "../../../src/dashboard/health-dashboard.repository";
import { EncryptionService } from "../../../src/encryption/encryption.service";
import { InMemoryAuditService } from "../../../src/tenants/ports/in-memory/in-memory-audit.service";
import { InMemoryKmsService } from "../../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../../src/tenants/tenant.repository";
import { buildAdapterHealthService } from "../../helpers/build-adapter-health-service";
import { RedisPubSubService } from "../../../src/websocket-gateway/redis-pubsub.service";

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_AVAILABLE = process.env.SKIP_REDIS_TESTS !== "true";
const skip = !DATABASE_URL || !REDIS_AVAILABLE;

function randomSlug(): string {
  return `test-suppress-${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM false_positive_feedback WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM alert_snooze_configs WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM alert_auto_tune_state WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM alert_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM alert_threshold_configs WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM agent_metrics WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM agents WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

async function ensureCurrentMetricsPartition(pool: Pool): Promise<void> {
  await pool.query("SELECT create_agent_metrics_partitions(now(), 24)");
}

async function refreshHealthView(pool: Pool): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await pool.query("REFRESH MATERIALIZED VIEW CONCURRENTLY agent_health_5s_agg");
      return;
    } catch (err) {
      lastErr = err;
      try {
        await pool.query("REFRESH MATERIALIZED VIEW agent_health_5s_agg");
        return;
      } catch (err2) {
        lastErr = err2;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }
  throw lastErr;
}

async function provisionTenantAndAgent(pool: Pool, slug: string) {
  const kms = new InMemoryKmsService();
  const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
  const audit = new PostgresAuditService(pool);
  const encryptionService = new EncryptionService(pool, kms, new TenantKeyMetadataRepository(), audit);
  const agentsRepository = new AgentsRepository(pool);
  const agentsService = new AgentsService(pool, agentsRepository, encryptionService, audit, buildAdapterHealthService(pool));
  const tenant = await saga.provision({ name: `Suppress ${slug}`, slug, dataResidencyRegion: "us", actorId: null });
  const agent = await agentsService.create(pool, tenant.id, null, { name: "Suppression Agent", framework: "langchain", connectionConfig: {} });
  return { tenant, agent, encryptionService };
}

function buildAlertDeliveryService(pool: Pool, encryptionService: EncryptionService) {
  const webhookConfigRepository = new WebhookConfigRepository(pool);
  const emailConfigRepository = new EmailChannelConfigRepository(pool);
  const configCache = new ChannelConfigCacheService();
  const deliveryLogRepository = new AlertDeliveryLogRepository(pool);
  const alertsPubsub = new RedisPubSubService();
  const websocketChannel = new WebSocketAlertChannelService(alertsPubsub);
  const webhookChannel = new WebhookAlertChannelService();
  const emailProvider = new InMemoryEmailProviderService();
  const agentsRepository = new AgentsRepository(pool);
  const emailChannel = new EmailAlertChannelService(emailProvider, agentsRepository, new PhiScrubberService());
  const auditService = new InMemoryAuditService();

  const deliveryService = new AlertDeliveryService(
    webhookConfigRepository,
    emailConfigRepository,
    configCache,
    encryptionService,
    deliveryLogRepository,
    websocketChannel,
    webhookChannel,
    emailChannel,
    auditService,
  );
  return { deliveryService, configCache, alertsPubsub, emailChannel };
}

async function injectErrorRate(pool: Pool, tenantId: string, agentId: string, errorRate: number): Promise<void> {
  const metricsAggregator = new MetricsAggregatorService(new MetricsAggregatorRepository(pool));
  const event: CanonicalTelemetryEvent = {
    event_id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    agent_id: agentId,
    tenant_id: tenantId,
    timestamp: new Date().toISOString(),
    event_type: TelemetryEventType.METRIC,
    latency_ms: 150,
    error_rate: errorRate,
    token_consumption: 10,
    tool_call_success: true,
    tool_call_name: null,
    framework_type: "langchain",
    adapter_version: "test-1.0.0",
    raw_payload_hash: "test-hash",
    metadata: {},
  };
  await metricsAggregator.recordCanonicalEvent(pool, event);
}

test("real Postgres+Redis: 3 false-positive feedbacks with zero confirmations trigger auto-tune, suppressing a subsequent warning-level breach at the original threshold, while a genuine critical breach still fires", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();

  const eventRepository = new AlertEventRepository(pool);
  const feedbackRepository = new FalsePositiveFeedbackRepository(pool);
  const autoTuneStateRepository = new AlertAutoTuneStateRepository(pool);
  const snoozeRepository = new AlertSnoozeRepository(pool);
  const thresholdRepository = new AlertThresholdRepository(pool);
  const snapshotCache = new MetricSnapshotCacheService();
  const healthRepository = new HealthDashboardRepository(pool);
  const auditService = new InMemoryAuditService();
  let configCache: ChannelConfigCacheService | undefined;
  let alertsPubsub: RedisPubSubService | undefined;
  let emailChannel: EmailAlertChannelService | undefined;
  let suppressionService: AlertSuppressionService | undefined;

  try {
    const { tenant, agent, encryptionService } = await provisionTenantAndAgent(pool, slug);
    await ensureCurrentMetricsPartition(pool);
    const built = buildAlertDeliveryService(pool, encryptionService);
    configCache = built.configCache;
    alertsPubsub = built.alertsPubsub;
    emailChannel = built.emailChannel;

    suppressionService = new AlertSuppressionService(snoozeRepository, autoTuneStateRepository, feedbackRepository, auditService);
    const feedbackService = new AlertFeedbackService(feedbackRepository, eventRepository, auditService);
    const autoTuneScheduler = new AutoTuneSchedulerService(feedbackRepository, autoTuneStateRepository, auditService);
    const evaluator = new ThresholdEvaluatorService(thresholdRepository, eventRepository, snapshotCache, healthRepository, built.deliveryService, suppressionService);

    await thresholdRepository.create(pool, tenant.id, agent.id, { metricName: "error_rate", warningThreshold: 0.03, criticalThreshold: 0.05, cooldownSeconds: 0, createdBy: null });

    // Genuinely generate (not fabricate) 3 real alert events for this agent+metric pattern to attach feedback to, one at a time so cooldownSeconds=0 doesn't collapse them into fewer distinct breach timestamps.
    const rawEvents = [];
    for (let i = 0; i < 3; i++) {
      const event = await eventRepository.create(pool, tenant.id, agent.id, { metricName: "error_rate", thresholdValue: 0.03, actualValue: 0.04, severity: "warning", breachTimestamp: new Date(Date.now() - (3 - i) * 1000) });
      rawEvents.push(event);
    }

    // Submit 3 false-positive feedbacks (AC's own trigger condition), zero confirmations.
    for (const event of rawEvents) {
      await feedbackService.submitFeedback(pool, tenant.id, "00000000-0000-0000-0000-0000000000a1", event.id, "false_positive");
    }

    await autoTuneScheduler.tuneTenant(tenant.id);

    const tunedState = await autoTuneStateRepository.findByPattern(pool, tenant.id, agent.id, "error_rate");
    assert.ok(tunedState);
    assert.equal(tunedState!.warningMultiplier, 1.2, "one tuning step (+20%) should have been applied");

    // A value that breaches the ORIGINAL warning threshold (0.03) but not the tuned one (0.036) must now be suppressed.
    await injectErrorRate(pool, tenant.id, agent.id, 0.032);
    await refreshHealthView(pool);
    const suppressedPass = await evaluator.evaluateTenant(tenant.id);
    assert.equal(suppressedPass.length, 0, "a value only breaching the pre-tuning warning threshold should no longer alert");

    // A genuine critical-level breach must still fire regardless of the tuned warning threshold.
    await injectErrorRate(pool, tenant.id, agent.id, 0.9);
    await refreshHealthView(pool);
    let criticalPass: Awaited<ReturnType<typeof evaluator.evaluateTenant>> = [];
    for (let attempt = 0; attempt < 5 && criticalPass.length === 0; attempt++) {
      criticalPass = await evaluator.evaluateTenant(tenant.id);
      if (criticalPass.length === 0) await new Promise((resolve) => setTimeout(resolve, 300));
    }
    assert.equal(criticalPass.length, 1);
    assert.equal(criticalPass[0].severity, "critical");

    const metrics = await suppressionService.getSuppressionMetrics(pool, tenant.id);
    assert.equal(metrics.feedbackCount, 3);
    assert.equal(metrics.falsePositiveRate, 1);
    assert.equal(metrics.autoTunedCount, 1);
  } finally {
    await snapshotCache.onModuleDestroy();
    await configCache?.onModuleDestroy();
    await emailChannel?.onModuleDestroy();
    await alertsPubsub?.onModuleDestroy();
    await suppressionService?.onModuleDestroy();
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("real Postgres+Redis: a manual snooze suppresses a critical-severity breach too, until it expires", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();

  const eventRepository = new AlertEventRepository(pool);
  const feedbackRepository = new FalsePositiveFeedbackRepository(pool);
  const autoTuneStateRepository = new AlertAutoTuneStateRepository(pool);
  const snoozeRepository = new AlertSnoozeRepository(pool);
  const thresholdRepository = new AlertThresholdRepository(pool);
  const snapshotCache = new MetricSnapshotCacheService();
  const healthRepository = new HealthDashboardRepository(pool);
  const auditService = new InMemoryAuditService();
  let configCache: ChannelConfigCacheService | undefined;
  let alertsPubsub: RedisPubSubService | undefined;
  let emailChannel: EmailAlertChannelService | undefined;
  let suppressionService: AlertSuppressionService | undefined;

  try {
    const { tenant, agent, encryptionService } = await provisionTenantAndAgent(pool, slug);
    await ensureCurrentMetricsPartition(pool);
    const built = buildAlertDeliveryService(pool, encryptionService);
    configCache = built.configCache;
    alertsPubsub = built.alertsPubsub;
    emailChannel = built.emailChannel;

    suppressionService = new AlertSuppressionService(snoozeRepository, autoTuneStateRepository, feedbackRepository, auditService);
    const evaluator = new ThresholdEvaluatorService(thresholdRepository, eventRepository, snapshotCache, healthRepository, built.deliveryService, suppressionService);

    await thresholdRepository.create(pool, tenant.id, agent.id, { metricName: "error_rate", warningThreshold: 0.03, criticalThreshold: 0.05, cooldownSeconds: 0, createdBy: null });
    await suppressionService.createSnooze(pool, tenant.id, "00000000-0000-0000-0000-0000000000a1", agent.id, "error_rate", "1h");

    await injectErrorRate(pool, tenant.id, agent.id, 0.9); // well above critical
    await refreshHealthView(pool);
    const events = await evaluator.evaluateTenant(tenant.id);
    assert.equal(events.length, 0, "an active manual snooze must suppress even a critical breach");
  } finally {
    await snapshotCache.onModuleDestroy();
    await configCache?.onModuleDestroy();
    await emailChannel?.onModuleDestroy();
    await alertsPubsub?.onModuleDestroy();
    await suppressionService?.onModuleDestroy();
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});
