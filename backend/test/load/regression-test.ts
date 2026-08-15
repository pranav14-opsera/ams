/**
 * WO-044 CI regression entrypoint. A reduced-scale version of the 1x
 * profile (short duration, same events/sec target) run against real
 * Postgres, asserting every measurable segment's P99 stays within its
 * budget plus the AC's own 20% tolerance. Exits non-zero with a detailed
 * failure report on any violation — meant to be wired into CI as a
 * regular script, not a node:test file (a failing budget should fail the
 * build directly, not just report a failed test among hundreds of
 * others).
 *
 * Requires DATABASE_URL. Skips (exit 0, prints a notice) if unset, the
 * same convention every other real-Postgres test in this repo already
 * follows, rather than failing a build that has no database available.
 */
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
import { CI_REGRESSION_TOLERANCE, LATENCY_BUDGETS_P99_MS } from "./latency-budgets";
import { writeReport } from "./latency-report";
import profile1x from "./profiles/1x-sustained.json";
import { runLoadTest } from "./run-load-test";
import type { SyntheticTenantAgent } from "./synthetic-event-generator";

const DATABASE_URL = process.env.DATABASE_URL;
// Reduced from the AC's literal 5-minute regression run for CI time
// budget — see LOAD_TEST_RESULTS.md for the full-duration manual run.
const REGRESSION_DURATION_SECONDS = Number(process.env.LOAD_REGRESSION_DURATION_SECONDS ?? 20);
const REPORT_PATH = process.env.LOAD_REGRESSION_REPORT_PATH ?? "load-regression-report.json";

function randomSlug(): string {
  return `ci-load-regression-${Math.random().toString(36).slice(2, 8)}`;
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

async function main(): Promise<number> {
  if (!DATABASE_URL) {
    console.log("LOAD_REGRESSION: DATABASE_URL not set — skipping (no database available in this environment).");
    return 0;
  }

  const pool = new Pool({ connectionString: DATABASE_URL });
  const slugs = Array.from({ length: profile1x.numTenants }, () => randomSlug());
  let kafkaProducer: KafkaTelemetryProducerService | undefined;

  try {
    const kms = new InMemoryKmsService();
    const saga = new TenantProvisioningSaga(pool, new TenantRepository(), new TenantKeyMetadataRepository(), kms, new PostgresRbacService(pool), new PostgresAuditService(pool));
    const audit = new PostgresAuditService(pool);
    const encryptionService = new EncryptionService(pool, kms, new TenantKeyMetadataRepository(), audit);
    const agentsRepository = new AgentsRepository(pool);
    const agentsService = new AgentsService(pool, agentsRepository, encryptionService, audit, buildAdapterHealthService(pool));

    const tenantAgentPool: SyntheticTenantAgent[][] = [];
    for (const slug of slugs) {
      const tenant = await saga.provision({ name: `CI Load Regression ${slug}`, slug, dataResidencyRegion: "us", actorId: null });
      const agents: SyntheticTenantAgent[] = [];
      for (let a = 0; a < profile1x.numAgentsPerTenant; a++) {
        const agent = await agentsService.create(pool, tenant.id, null, { name: `Agent ${a}`, framework: "generic_rest", connectionConfig: {} });
        agents.push({ tenantId: tenant.id, agentId: agent.id });
      }
      tenantAgentPool.push(agents);
    }

    const phiScrubber = new PhiScrubberService();
    kafkaProducer = new KafkaTelemetryProducerService();
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

    console.log(`LOAD_REGRESSION: running ${profile1x.name} at ${profile1x.eventsPerSecond} events/sec for ${REGRESSION_DURATION_SECONDS}s (reduced from the AC's 5-minute figure for CI time budget)...`);
    const { report } = await runLoadTest(pipeline, tenantAgentPool, { ...profile1x }, { durationSecondsOverride: REGRESSION_DURATION_SECONDS });

    writeReport(REPORT_PATH, report);
    console.log(`LOAD_REGRESSION: report written to ${REPORT_PATH}`);

    let failed = false;
    for (const [stage, budgetMs] of Object.entries(LATENCY_BUDGETS_P99_MS)) {
      const stats = report.segments[stage];
      if (!stats || stats.count === 0) continue;
      const toleratedBudgetMs = budgetMs * CI_REGRESSION_TOLERANCE;
      const withinBudget = stats.p99 <= toleratedBudgetMs;
      console.log(`LOAD_REGRESSION: stage="${stage}" p99=${stats.p99.toFixed(2)}ms budget=${budgetMs}ms (+20% tolerance = ${toleratedBudgetMs.toFixed(2)}ms) -> ${withinBudget ? "PASS" : "FAIL"}`);
      if (!withinBudget) failed = true;
    }

    if (report.errorCount > 0) {
      console.log(`LOAD_REGRESSION: FAIL — ${report.errorCount} event(s) threw an unhandled error during the run.`);
      failed = true;
    }

    return failed ? 1 : 0;
  } finally {
    if (kafkaProducer) await kafkaProducer.onModuleDestroy();
    await cleanupTenants(pool, slugs);
    await pool.end();
  }
}

main()
  .then((exitCode) => process.exit(exitCode))
  .catch((err) => {
    console.error("LOAD_REGRESSION: crashed", err);
    process.exit(1);
  });
