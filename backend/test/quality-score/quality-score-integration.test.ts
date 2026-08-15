import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { AgentsRepository } from "../../src/agents/agents.repository";
import { AgentsService } from "../../src/agents/agents.service";
import { buildAdapterHealthService } from "../helpers/build-adapter-health-service";
import { EncryptionService } from "../../src/encryption/encryption.service";
import { InMemoryKmsService } from "../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../src/tenants/tenant.repository";
import { TraceRepository } from "../../src/traces/trace.repository";
import type { TraceStep } from "../../src/traces/trace.types";
import { QualityScoreRepository } from "../../src/quality-score/quality-score.repository";
import { QualityScoreService } from "../../src/quality-score/quality-score.service";
import { QualityScoreSchedulerService } from "../../src/quality-score/quality-score.scheduler.service";
import { QualityScoreLockService } from "../../src/quality-score/quality-score-lock.service";

const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_AVAILABLE = process.env.SKIP_REDIS_TESTS !== "true";
const skip = !DATABASE_URL || !REDIS_AVAILABLE;

function randomSlug(): string {
  return `test-qscore-${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanupTenant(pool: Pool, slug: string): Promise<void> {
  const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
  if (tenant.rows.length === 0) return;
  const tenantId = tenant.rows[0].id;
  await pool.query("DELETE FROM quality_score_history WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM quality_score_baselines WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM quality_score_configs WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM agent_execution_traces WHERE tenant_id = $1", [tenantId]);
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
  const tenant = await saga.provision({ name: `QScore ${slug}`, slug, dataResidencyRegion: "us", actorId: null });
  const agent = await agentsService.create(pool, tenant.id, null, { name: "Quality Score Agent", framework: "langchain", connectionConfig: {} });
  return { tenant, agent };
}

function makeStep(durationMs: number, status: "success" | "error" = "success"): TraceStep {
  return { stepName: "reason", toolName: null, durationMs, status, inputSummary: "input", outputSummary: "output" };
}

async function ensureCurrentMetricsPartition(pool: Pool): Promise<void> {
  await pool.query("SELECT create_agent_metrics_partitions(now(), 2)");
}

async function seedToolCallSuccess(pool: Pool, tenantId: string, agentId: string, successFraction: number, count: number): Promise<void> {
  const successCount = Math.round(count * successFraction);
  for (let i = 0; i < count; i++) {
    await pool.query("INSERT INTO agent_metrics (tenant_id, agent_id, metric_name, value, recorded_at) VALUES ($1, $2, 'tool_call_success', $3, now())", [tenantId, agentId, i < successCount ? 1 : 0]);
  }
}

test("real Postgres: a genuine composite quality score is computed from real execution traces and telemetry, stored, and retrievable via the service", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();

  const repository = new QualityScoreRepository(pool);
  const service = new QualityScoreService(repository);
  const traceRepository = new TraceRepository(pool);

  try {
    const { tenant, agent } = await provisionTenantAndAgent(pool, slug);
    await ensureCurrentMetricsPartition(pool);

    // Real tool-call telemetry: 9/10 successful.
    await seedToolCallSuccess(pool, tenant.id, agent.id, 0.9, 10);

    // Real execution traces: 8 completed, 2 failed (reasoning-accuracy proxy = 0.8).
    for (let i = 0; i < 8; i++) {
      await traceRepository.create(pool, tenant.id, agent.id, { status: "completed", startedAt: new Date(), durationMs: 500, steps: [makeStep(500), makeStep(510)] });
    }
    for (let i = 0; i < 2; i++) {
      await traceRepository.create(pool, tenant.id, agent.id, { status: "failed", startedAt: new Date(), durationMs: 400, steps: [makeStep(400, "error")] });
    }

    const result = await service.computeScoreForAgent(pool, tenant.id, agent.id);
    assert.ok(result.compositeScore !== null);
    assert.ok(result.componentScores.toolCall !== null && result.componentScores.toolCall >= 85 && result.componentScores.toolCall <= 95);
    assert.ok(result.componentScores.reasoning !== null && result.componentScores.reasoning >= 75 && result.componentScores.reasoning <= 85);
    // Consistency: durations cluster tightly around 500-510ms (low coefficient of variation) -> a high consistency score.
    assert.ok(result.componentScores.consistency !== null && result.componentScores.consistency >= 90);

    const stored = await service.computeAndStoreScoreForAgent(pool, tenant.id, agent.id);
    assert.equal(stored.compositeScore, result.compositeScore);

    const summary = await service.getAgentSummary(pool, tenant.id, agent.id);
    assert.equal(summary.current?.compositeScore, result.compositeScore);
    assert.ok(summary.colorIndicator === "green" || summary.colorIndicator === "amber");
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("real Postgres: an agent with erratic step durations (high variance) scores a low output-consistency component", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();

  const repository = new QualityScoreRepository(pool);
  const service = new QualityScoreService(repository);
  const traceRepository = new TraceRepository(pool);

  try {
    const { tenant, agent } = await provisionTenantAndAgent(pool, slug);
    const durations = [50, 5000, 100, 8000, 200, 6000];
    for (const d of durations) {
      await traceRepository.create(pool, tenant.id, agent.id, { status: "completed", startedAt: new Date(), durationMs: d, steps: [makeStep(d)] });
    }

    const result = await service.computeScoreForAgent(pool, tenant.id, agent.id);
    assert.ok(result.componentScores.consistency !== null && result.componentScores.consistency < 50, `expected a low consistency score for erratic durations, got ${result.componentScores.consistency}`);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("real Postgres+Redis: baseline establishment computes the real median across accumulated history once the calibration window has elapsed", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();

  const repository = new QualityScoreRepository(pool);
  const service = new QualityScoreService(repository);

  try {
    const { tenant, agent } = await provisionTenantAndAgent(pool, slug);
    await service.startCalibration(pool, tenant.id, agent.id);
    await pool.query("UPDATE quality_score_baselines SET calibration_started_at = now() - interval '8 days' WHERE tenant_id = $1 AND agent_id = $2", [tenant.id, agent.id]);

    const scores = [70, 75, 80, 85, 90];
    for (const score of scores) {
      await pool.query(
        "INSERT INTO quality_score_history (tenant_id, agent_id, composite_score, sample_count) VALUES ($1, $2, $3, 3)",
        [tenant.id, agent.id, score],
      );
    }

    const established = await service.checkAndEstablishBaseline(pool, tenant.id, agent.id);
    assert.equal(established, true);

    const baseline = await repository.findBaseline(pool, tenant.id, agent.id);
    assert.equal(baseline?.baselineScore, 80); // real median of [70,75,80,85,90]
    assert.ok(baseline?.establishedAt);
  } finally {
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});

test("real Postgres+Redis: the scheduler computes and stores a real score for an active agent end-to-end, gated by the distributed lock", { skip }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slug = randomSlug();

  const repository = new QualityScoreRepository(pool);
  const service = new QualityScoreService(repository);
  const lock = new QualityScoreLockService();
  const scheduler = new QualityScoreSchedulerService(repository, service, lock);

  try {
    const { tenant, agent } = await provisionTenantAndAgent(pool, slug);
    await ensureCurrentMetricsPartition(pool);
    await seedToolCallSuccess(pool, tenant.id, agent.id, 1, 5);

    await scheduler.runTick();

    const history = await repository.getScoreHistory(pool, tenant.id, agent.id, new Date(Date.now() - 60_000).toISOString());
    assert.equal(history.length, 1);
    assert.ok(history[0].compositeScore !== null);
  } finally {
    await lock.onModuleDestroy();
    await cleanupTenant(pool, slug);
    await pool.end();
  }
});
