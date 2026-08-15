import { test } from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { KafkaCircuitBreakerProducerService } from "../../src/adapters/kafka/kafka-circuit-breaker-producer.service";
import { KafkaTelemetryProducerService } from "../../src/adapters/kafka/kafka-telemetry-producer.service";
import { TelemetryDeadLetterRepository } from "../../src/adapters/kafka/telemetry-dead-letter.repository";
import { MetricsAggregatorRepository } from "../../src/adapters/metrics/metrics-aggregator.repository";
import { MetricsAggregatorService } from "../../src/adapters/metrics/metrics-aggregator.service";
import { TelemetryPipelineService } from "../../src/adapters/pipeline/telemetry-pipeline.service";
import { TelemetrySchemaValidatorService } from "../../src/adapters/telemetry-schema-validator.service";
import { AgentsRepository } from "../../src/agents/agents.repository";
import { AgentsService } from "../../src/agents/agents.service";
import { ClassificationRuleEngine } from "../../src/classification/classification-rule-engine";
import { DataClassificationTagger } from "../../src/classification/data-classification-tagger";
import { EncryptionService } from "../../src/encryption/encryption.service";
import { PhiAuditEmitter } from "../../src/phi-scrubber/phi-audit-emitter";
import { PhiQuarantineRepository } from "../../src/phi-scrubber/phi-quarantine.repository";
import { PhiScrubberService } from "../../src/phi-scrubber/phi-scrubber.service";
import { PhiSecondaryValidator } from "../../src/phi-scrubber/phi-secondary-validator";
import { InMemoryKmsService } from "../../src/tenants/ports/in-memory/in-memory-kms.service";
import { PostgresAuditService } from "../../src/tenants/ports/postgres/postgres-audit.service";
import { PostgresRbacService } from "../../src/tenants/ports/postgres/postgres-rbac.service";
import { TenantKeyMetadataRepository } from "../../src/tenants/tenant-key-metadata.repository";
import { TenantProvisioningSaga } from "../../src/tenants/tenant-provisioning.saga";
import { TenantRepository } from "../../src/tenants/tenant.repository";
import { buildAdapterHealthService } from "../helpers/build-adapter-health-service";
import { LATENCY_BUDGETS_P99_MS } from "./latency-budgets";
import profile1x from "./profiles/1x-sustained.json";
import { runLoadTest } from "./run-load-test";
import type { SyntheticTenantAgent } from "./synthetic-event-generator";

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

function randomSlug(): string {
  return `test-load-${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanupTenants(pool: Pool, slugs: string[]): Promise<void> {
  for (const slug of slugs) {
    const tenant = await pool.query("SELECT id FROM tenants WHERE slug = $1", [slug]);
    if (tenant.rows.length === 0) continue;
    const tenantId = tenant.rows[0].id;
    await pool.query("DELETE FROM agent_metrics WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM telemetry_dead_letter_events WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM phi_quarantine_events WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM audit_events WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM agents WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM rbac_policies WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
  }
}

/**
 * WO-044: this is the AC's own literal "integration tests are the load
 * tests themselves" — drives the 1x profile's real event rate through
 * the REAL pipeline against real Postgres, for a short slice (not the
 * full 1800s — see run-load-test.ts's durationSecondsOverride doc and
 * LOAD_TEST_RESULTS.md for full-duration results from a real run).
 */
test("load test (1x profile, reduced duration): all measurable segments stay within their P99 budgets", { skip, timeout: 60_000 }, async () => {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const slugs = Array.from({ length: profile1x.numTenants }, () => randomSlug());

  try {
    const kms = new InMemoryKmsService();
    const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
    const audit = new PostgresAuditService(pool);
    const encryptionService = new EncryptionService(pool, kms, new TenantKeyMetadataRepository(), audit);
    const agentsRepository = new AgentsRepository(pool);
    const agentsService = new AgentsService(pool, agentsRepository, encryptionService, audit, buildAdapterHealthService(pool));

    const pool_: SyntheticTenantAgent[][] = [];
    for (const slug of slugs) {
      const tenant = await saga.provision({ name: `Load Test ${slug}`, slug, dataResidencyRegion: "us", actorId: null });
      const agents: SyntheticTenantAgent[] = [];
      for (let a = 0; a < profile1x.numAgentsPerTenant; a++) {
        const agent = await agentsService.create(pool, tenant.id, null, { name: `Agent ${a}`, framework: "generic_rest", connectionConfig: {} });
        agents.push({ tenantId: tenant.id, agentId: agent.id });
      }
      pool_.push(agents);
    }

    const phiScrubber = new PhiScrubberService();
    const kafkaProducer = new KafkaTelemetryProducerService();
    const circuitBreaker = new KafkaCircuitBreakerProducerService(kafkaProducer);
    const pipeline = new TelemetryPipelineService(
      pool,
      new TelemetrySchemaValidatorService(),
      new TenantRepository(),
      new DataClassificationTagger(new ClassificationRuleEngine()),
      phiScrubber,
      circuitBreaker,
      new TelemetryDeadLetterRepository(pool),
      new MetricsAggregatorService(new MetricsAggregatorRepository(pool)),
      new PhiSecondaryValidator(phiScrubber),
      new PhiAuditEmitter(audit),
      new PhiQuarantineRepository(pool),
    );

    const { report } = await runLoadTest(pipeline, pool_.flat().length ? pool_ : [[]], { ...profile1x, name: profile1x.name }, { durationSecondsOverride: 5 });

    assert.ok(report.eventCount > 0, "the load test must have actually driven events through the pipeline");
    assert.equal(report.errorCount, 0, "no event should throw an unhandled error during a normal-load run");

    for (const [stage, budgetMs] of Object.entries(LATENCY_BUDGETS_P99_MS)) {
      const stats = report.segments[stage];
      if (!stats || stats.count === 0) continue; // websocket_delivery is measured in a separate test file
      assert.ok(stats.p99 <= budgetMs, `stage "${stage}" P99 was ${stats.p99.toFixed(2)}ms, exceeding its ${budgetMs}ms budget`);
    }

    await kafkaProducer.onModuleDestroy();
  } finally {
    await cleanupTenants(pool, slugs);
    await pool.end();
  }
});
