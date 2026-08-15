import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { AgentsRepository } from "../../src/agents/agents.repository";
import { AgentsService } from "../../src/agents/agents.service";
import { buildAdapterHealthService } from "../helpers/build-adapter-health-service";
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
import { EncryptionService } from "../../src/encryption/encryption.service";
import { InMemoryAuditService } from "../../src/tenants/ports/in-memory/in-memory-audit.service";
import { InMemoryKmsService } from "../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../src/tenants/tenant.repository";
import { RedisPubSubService } from "../../src/websocket-gateway/redis-pubsub.service";
import { QualityScoreRepository } from "../../src/quality-score/quality-score.repository";
import { QualityScoreService } from "../../src/quality-score/quality-score.service";
import { DriftDetectionService } from "../../src/drift-detection/drift-detection.service";
import { DriftEventRepository } from "../../src/drift-detection/drift-event.repository";
import { DriftStateRepository } from "../../src/drift-detection/drift-state.repository";
import { DriftStateCacheService } from "../../src/drift-detection/drift-state-cache.service";

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_AVAILABLE = process.env.SKIP_REDIS_TESTS !== "true";
const skip = !DATABASE_URL || !REDIS_AVAILABLE;

function randomSlug(): string {
  return `test-drift-${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM drift_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM drift_detection_state WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM alert_events WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM quality_score_history WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM quality_score_baselines WHERE tenant_id = $1", [tenantId]);
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
  const tenant = await saga.provision({ name: `Drift ${slug}`, slug, dataResidencyRegion: "us", actorId: null });
  const agent = await agentsService.create(pool, tenant.id, null, { name: "Drift Agent", framework: "langchain", connectionConfig: {} });
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

async function seedQualityScores(pool: Pool, tenantId: string, agentId: string, scores: number[], at: Date): Promise<void> {
  for (const score of scores) {
    await pool.query("INSERT INTO quality_score_history (tenant_id, agent_id, composite_score, tool_call_score, reasoning_score, consistency_score, sample_count, computed_at) VALUES ($1, $2, $3, $3, $3, $3, 3, $4)", [
      tenantId,
      agentId,
      score,
      at,
    ]);
  }
}

test("real Postgres+Redis: baseline-matching history establishes a real baseline, then 3 consecutive hours of genuinely degraded scores trigger a drift alert with correct KS evidence, delivered through the shared pipeline", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();

  const qualityScoreRepository = new QualityScoreRepository(pool);
  const qualityScoreService = new QualityScoreService(qualityScoreRepository);
  const driftEventRepository = new DriftEventRepository(pool);
  const driftStateRepository = new DriftStateRepository(pool);
  const driftStateCache = new DriftStateCacheService();
  const alertEventRepository = new AlertEventRepository(pool);
  let configCache: ChannelConfigCacheService | undefined;
  let alertsPubsub: RedisPubSubService | undefined;
  let emailChannel: EmailAlertChannelService | undefined;

  try {
    const { tenant, agent, encryptionService } = await provisionTenantAndAgent(pool, slug);
    const built = buildAlertDeliveryService(pool, encryptionService);
    configCache = built.configCache;
    alertsPubsub = built.alertsPubsub;
    emailChannel = built.emailChannel;

    const driftService = new DriftDetectionService(qualityScoreRepository, driftEventRepository, driftStateRepository, driftStateCache, alertEventRepository, built.deliveryService);

    // Establish a real baseline: seed a real 7-day calibration window's worth of stable, healthy scores (~85), then complete it.
    await qualityScoreService.startCalibration(pool, tenant.id, agent.id);
    const calibrationBackdate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await pool.query("UPDATE quality_score_baselines SET calibration_started_at = $1 WHERE tenant_id = $2 AND agent_id = $3", [calibrationBackdate, tenant.id, agent.id]);
    for (let hoursAgo = 7 * 24; hoursAgo >= 30; hoursAgo -= 6) {
      await seedQualityScores(pool, tenant.id, agent.id, [83, 85, 87, 84, 86], new Date(Date.now() - hoursAgo * 60 * 60 * 1000));
    }
    const established = await qualityScoreService.checkAndEstablishBaseline(pool, tenant.id, agent.id);
    assert.equal(established, true);
    const baseline = await qualityScoreRepository.findBaseline(pool, tenant.id, agent.id);
    assert.ok(baseline?.establishedAt);
    assert.ok(baseline!.baselineScore! >= 83 && baseline!.baselineScore! <= 87);

    // No drift yet — no recent (last 24h) scores exist at all.
    const before = await driftService.evaluateAgent(pool, tenant.id, agent.id);
    assert.equal(before, null);

    // 3 consecutive "hours" of genuinely degraded scores (~65 vs baseline's ~85).
    const now1 = new Date();
    await seedQualityScores(pool, tenant.id, agent.id, [62, 65, 68, 63, 66], now1);
    const eval1 = await driftService.evaluateAgent(pool, tenant.id, agent.id, now1);
    assert.equal(eval1?.driftStatus, "drifting");
    assert.equal(eval1?.consecutiveWindowCount, 1);

    const now2 = new Date(now1.getTime() + 60 * 60 * 1000);
    await seedQualityScores(pool, tenant.id, agent.id, [61, 64, 67, 62, 65], now2);
    const eval2 = await driftService.evaluateAgent(pool, tenant.id, agent.id, now2);
    assert.equal(eval2?.consecutiveWindowCount, 2);

    const now3 = new Date(now2.getTime() + 60 * 60 * 1000);
    await seedQualityScores(pool, tenant.id, agent.id, [60, 63, 66, 61, 64], now3);
    const eval3 = await driftService.evaluateAgent(pool, tenant.id, agent.id, now3);
    assert.equal(eval3?.driftStatus, "significant_drift");
    assert.equal(eval3?.consecutiveWindowCount, 3);
    assert.equal(eval3?.shouldAlert, true);
    assert.ok(eval3!.ksStatistic > 0.5, `expected a large KS statistic, got ${eval3!.ksStatistic}`);
    assert.ok(eval3!.pValue < 0.05, `expected a significant p-value, got ${eval3!.pValue}`);
    assert.ok(eval3!.baselineMean > eval3!.currentMean, "baseline mean should be genuinely higher than the degraded current mean");

    // A real drift_events row and a real, delivered alert_events row.
    const driftHistory = await driftEventRepository.findHistory(pool, tenant.id, agent.id, new Date(Date.now() - 60_000).toISOString());
    assert.equal(driftHistory.length, 1);
    assert.equal(driftHistory[0].consecutiveWindowCount, 3);

    const persistedAlert = await alertEventRepository.findMostRecent(pool, tenant.id, agent.id, "quality_drift");
    assert.ok(persistedAlert);
    assert.equal(persistedAlert!.detectionMethod, "drift");
    assert.equal(persistedAlert!.statisticalEvidence?.algorithmUsed, "ks_test");

    const deliveryLog = await built.deliveryLogRepository.findByAlertEvent(pool, tenant.id, persistedAlert!.id);
    assert.equal(deliveryLog.length, 1);
    assert.equal(deliveryLog[0].channel_type, "websocket");
    assert.equal(deliveryLog[0].status, "sent");
  } finally {
    await driftStateCache.onModuleDestroy();
    await configCache?.onModuleDestroy();
    await emailChannel?.onModuleDestroy();
    await alertsPubsub?.onModuleDestroy();
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});
