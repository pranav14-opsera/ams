import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { AlertDeliveryLogRepository } from "../../src/alerts/alert-delivery-log.repository";
import { AlertDeliveryService } from "../../src/alerts/alert-delivery.service";
import { AlertEventRepository } from "../../src/alerts/alert-event.repository";
import { ChannelConfigCacheService } from "../../src/alerts/channel-config-cache.service";
import { EmailAlertChannelService } from "../../src/alerts/channels/email-alert-channel.service";
import { WebhookAlertChannelService } from "../../src/alerts/channels/webhook-alert-channel.service";
import { WebSocketAlertChannelService } from "../../src/alerts/channels/websocket-alert-channel.service";
import { EmailChannelConfigRepository } from "../../src/alerts/email-channel-config.repository";
import { InMemoryEmailProviderService } from "../../src/alerts/ports/in-memory/in-memory-email-provider.service";
import { WebhookConfigRepository } from "../../src/alerts/webhook-config.repository";
import { PhiScrubberService } from "../../src/phi-scrubber/phi-scrubber.service";
import { AgentsRepository } from "../../src/agents/agents.repository";
import { AgentsService } from "../../src/agents/agents.service";
import { EncryptionService } from "../../src/encryption/encryption.service";
import { InMemoryAuditService } from "../../src/tenants/ports/in-memory/in-memory-audit.service";
import { InMemoryKmsService } from "../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../src/tenants/tenant.repository";
import { buildAdapterHealthService } from "../helpers/build-adapter-health-service";
import { RedisPubSubService } from "../../src/websocket-gateway/redis-pubsub.service";
import { AnomalyBaselineRepository } from "../../src/anomaly-detection/anomaly-baseline.repository";
import { AnomalyDetectorService } from "../../src/anomaly-detection/anomaly-detector.service";
import { CalibrationService } from "../../src/anomaly-detection/calibration.service";
import { DriftDetectionConfigRepository } from "../../src/anomaly-detection/drift-detection-config.repository";
import { EwmaStateCacheService } from "../../src/anomaly-detection/ewma-state-cache.service";

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_AVAILABLE = process.env.SKIP_REDIS_TESTS !== "true";
const skip = !DATABASE_URL || !REDIS_AVAILABLE;

const CALIBRATION_WINDOW_HOURS = 7 * 24; // matches CALIBRATION_PERIOD_DAYS

function randomSlug(): string {
  return `test-anomaly-${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM alert_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM anomaly_baselines WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM drift_detection_configs WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM agent_metrics WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM agents WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
}

async function provisionTenantAndAgent(pool: Pool, slug: string) {
  const kms = new InMemoryKmsService();
  const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
  const audit = new PostgresAuditService(pool);
  const encryptionService = new EncryptionService(pool, kms, new TenantKeyMetadataRepository(), audit);
  const agentsRepository = new AgentsRepository(pool);
  const agentsService = new AgentsService(pool, agentsRepository, encryptionService, audit, buildAdapterHealthService(pool));
  const tenant = await saga.provision({ name: `Anomaly ${slug}`, slug, dataResidencyRegion: "us", actorId: null });
  const agent = await agentsService.create(pool, tenant.id, null, { name: "Anomaly Agent", framework: "langchain", connectionConfig: {} });
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

  return { deliveryService, deliveryLogRepository, configCache, alertsPubsub, emailChannel };
}

async function refreshHourlyAgg(pool: Pool): Promise<void> {
  await pool.query("REFRESH MATERIALIZED VIEW agent_metrics_1hr_agg");
}

/** Seeds ~7 days of normal, in-band hourly telemetry for latency/error_rate/token_consumption, per this WO's own AC distributions (latency ~200ms/20ms stddev, error_rate ~2%/0.5% stddev, token_consumption ~500/50 stddev). One raw sample per metric per hour is enough — the 1hr aggregate is avg/var_pop over these hourly buckets, not over sub-hour raw samples. */
async function seedNormalHistory(pool: Pool, tenantId: string, agentId: string, now: Date): Promise<void> {
  const rows: Array<{ metric: string; value: number; recordedAt: Date }> = [];
  for (let hoursAgo = CALIBRATION_WINDOW_HOURS; hoursAgo >= 1; hoursAgo--) {
    const recordedAt = new Date(now.getTime() - hoursAgo * 60 * 60 * 1000);
    const wobble = Math.sin(hoursAgo * 0.37); // deterministic in-band variation, bounded [-1, 1]
    rows.push({ metric: "latency_ms", value: 200 + wobble * 20, recordedAt });
    rows.push({ metric: "error_rate", value: 0.02 + wobble * 0.005, recordedAt });
    rows.push({ metric: "token_consumption", value: 500 + wobble * 50, recordedAt });
  }

  const values: unknown[] = [];
  const placeholders = rows
    .map((row, i) => {
      values.push(tenantId, agentId, row.metric, row.value, row.recordedAt.toISOString());
      const base = i * 5;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
    })
    .join(",");

  await pool.query(`INSERT INTO agent_metrics (tenant_id, agent_id, metric_name, value, recorded_at) VALUES ${placeholders}`, values);
}

test("real Postgres+Redis: EWMA (error_rate) and z-score (token_consumption) both detect a genuine anomaly after calibration completes, and deliver via the shared alert pipeline within the AC's 60s window", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();
  const startedAt = Date.now();

  const driftConfigRepository = new DriftDetectionConfigRepository(pool);
  const baselineRepository = new AnomalyBaselineRepository(pool);
  const calibrationService = new CalibrationService(pool, baselineRepository);
  const ewmaCache = new EwmaStateCacheService();
  const eventRepository = new AlertEventRepository(pool);
  let configCache: ChannelConfigCacheService | undefined;
  let alertsPubsub: RedisPubSubService | undefined;
  let emailChannel: EmailAlertChannelService | undefined;

  try {
    const { tenant, agent, encryptionService } = await provisionTenantAndAgent(pool, slug);
    const built = buildAlertDeliveryService(pool, encryptionService);
    const { deliveryService, deliveryLogRepository } = built;
    configCache = built.configCache;
    alertsPubsub = built.alertsPubsub;
    emailChannel = built.emailChannel;

    const detector = new AnomalyDetectorService(driftConfigRepository, baselineRepository, calibrationService, ewmaCache, eventRepository, deliveryService);

    const now = new Date();
    await pool.query("SELECT create_agent_metrics_partitions($1, $2)", [new Date(now.getTime() - CALIBRATION_WINDOW_HOURS * 60 * 60 * 1000), CALIBRATION_WINDOW_HOURS + 24]);

    await seedNormalHistory(pool, tenant.id, agent.id, now);
    await refreshHourlyAgg(pool);

    // AC: sensitivity="high" (2-sigma) makes this deterministic distribution's real, computed variance easy to breach with a genuine spike.
    await driftConfigRepository.upsert(pool, tenant.id, agent.id, "high", true);
    await calibrationService.startCalibration(pool, tenant.id, agent.id);
    // Backdate calibration_started_at so the 7-day window has already "elapsed" without a real 7-day wait — the calibration completion logic itself (checkAndCompleteCalibration) still runs for real against the real seeded history.
    await pool.query("UPDATE anomaly_baselines SET calibration_started_at = $1 WHERE tenant_id = $2 AND agent_id = $3", [new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000), tenant.id, agent.id]);

    // First pass: completes calibration for all 3 metrics from the real seeded history. No current-hour data exists yet, so no alert should fire.
    const firstPass = await detector.evaluateTenant(tenant.id, now);
    assert.equal(firstPass.length, 0, "no anomaly should fire before any current-hour data exists");

    const errorRateBaseline = await baselineRepository.findByAgentAndMetric(pool, tenant.id, agent.id, "error_rate");
    const tokenBaseline = await baselineRepository.findByAgentAndMetric(pool, tenant.id, agent.id, "token_consumption");
    assert.ok(errorRateBaseline?.calibrationCompletedAt, "error_rate calibration should have completed against the real 7-day seeded window");
    assert.ok(tokenBaseline?.calibrationCompletedAt, "token_consumption calibration should have completed against the real 7-day seeded window");
    assert.ok(Math.abs(errorRateBaseline!.baselineMean! - 0.02) < 0.01, "computed baseline mean should reflect the real seeded distribution");

    // Inject genuine anomalies into the CURRENT (not-yet-aggregated) hour — well outside both metrics' real computed variance.
    await pool.query("INSERT INTO agent_metrics (tenant_id, agent_id, metric_name, value, recorded_at) VALUES ($1, $2, 'error_rate', 0.9, $3)", [tenant.id, agent.id, now.toISOString()]);
    await pool.query("INSERT INTO agent_metrics (tenant_id, agent_id, metric_name, value, recorded_at) VALUES ($1, $2, 'token_consumption', 9000, $3)", [tenant.id, agent.id, now.toISOString()]);
    await refreshHourlyAgg(pool);

    let secondPass: Awaited<ReturnType<typeof detector.evaluateTenant>> = [];
    for (let attempt = 0; attempt < 5 && secondPass.length < 2; attempt++) {
      secondPass = await detector.evaluateTenant(tenant.id, now);
      if (secondPass.length < 2) await new Promise((resolve) => setTimeout(resolve, 300));
    }

    assert.equal(secondPass.length, 2, "both the EWMA (error_rate) and z-score (token_consumption) anomalies should be detected");
    const errorRateEvent = secondPass.find((e) => e.metricName === "error_rate");
    const tokenEvent = secondPass.find((e) => e.metricName === "token_consumption");
    assert.ok(errorRateEvent);
    assert.ok(tokenEvent);
    assert.equal(errorRateEvent!.detectionMethod, "anomaly");
    assert.equal(errorRateEvent!.statisticalEvidence?.algorithmUsed, "ewma");
    assert.equal(tokenEvent!.statisticalEvidence?.algorithmUsed, "zscore");
    assert.equal(errorRateEvent!.severity, "critical");

    // Genuinely persisted, not just returned in-memory.
    const persisted = await eventRepository.findMostRecent(pool, tenant.id, agent.id, "error_rate");
    assert.ok(persisted);
    assert.equal(persisted!.id, errorRateEvent!.id);

    // Delivered via the SAME pipeline as threshold alerts (AC) — at least the always-on websocket channel attempted for each.
    const errorRateDeliveryLog = await deliveryLogRepository.findByAlertEvent(pool, tenant.id, errorRateEvent!.id);
    assert.equal(errorRateDeliveryLog.length, 1);
    assert.equal(errorRateDeliveryLog[0].channel_type, "websocket");
    assert.equal(errorRateDeliveryLog[0].status, "sent");

    // Cooldown: re-evaluating immediately must not double-fire.
    const thirdPass = await detector.evaluateTenant(tenant.id, now);
    assert.equal(thirdPass.length, 0, "cooldown must suppress a second anomaly alert for the same agent+metric");

    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs < 60_000, `end-to-end calibrate->breach->alert flow took ${elapsedMs}ms, expected under the AC's own 60s window`);
  } finally {
    await ewmaCache.onModuleDestroy();
    await configCache?.onModuleDestroy();
    await emailChannel?.onModuleDestroy();
    await alertsPubsub?.onModuleDestroy();
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("real Postgres: an agent still within its 7-day calibration window never raises an anomaly, no matter how extreme the current value", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();

  const driftConfigRepository = new DriftDetectionConfigRepository(pool);
  const baselineRepository = new AnomalyBaselineRepository(pool);
  const calibrationService = new CalibrationService(pool, baselineRepository);
  const ewmaCache = new EwmaStateCacheService();
  const eventRepository = new AlertEventRepository(pool);
  let configCache: ChannelConfigCacheService | undefined;
  let alertsPubsub: RedisPubSubService | undefined;
  let emailChannel: EmailAlertChannelService | undefined;

  try {
    const { tenant, agent, encryptionService } = await provisionTenantAndAgent(pool, slug);
    const built = buildAlertDeliveryService(pool, encryptionService);
    configCache = built.configCache;
    alertsPubsub = built.alertsPubsub;
    emailChannel = built.emailChannel;
    const detector = new AnomalyDetectorService(driftConfigRepository, baselineRepository, calibrationService, ewmaCache, eventRepository, built.deliveryService);

    const now = new Date();
    await pool.query("SELECT create_agent_metrics_partitions($1, $2)", [now, 2]);
    await driftConfigRepository.upsert(pool, tenant.id, agent.id, "high", true);
    await calibrationService.startCalibration(pool, tenant.id, agent.id); // calibration_started_at = now, i.e. day 0 of 7

    await pool.query("INSERT INTO agent_metrics (tenant_id, agent_id, metric_name, value, recorded_at) VALUES ($1, $2, 'error_rate', 0.99, $3)", [tenant.id, agent.id, now.toISOString()]);
    await refreshHourlyAgg(pool);

    const events = await detector.evaluateTenant(tenant.id, now);
    assert.equal(events.length, 0, "a brand-new agent must never alert while still calibrating, regardless of how extreme its current value is");
  } finally {
    await ewmaCache.onModuleDestroy();
    await configCache?.onModuleDestroy();
    await emailChannel?.onModuleDestroy();
    await alertsPubsub?.onModuleDestroy();
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});
