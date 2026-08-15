import type { Pool } from "pg";
import { AdapterRegistryService } from "../../src/adapters/adapter-registry.service";
import { AdapterConfigurationRepository } from "../../src/adapters/health/adapter-configuration.repository";
import { AdapterHealthCheckRepository } from "../../src/adapters/health/adapter-health-check.repository";
import { AdapterHealthService } from "../../src/adapters/health/adapter-health.service";

/** A real AdapterHealthService (against real Postgres) for tests that construct AgentsService directly and don't otherwise care about WO-039's compatibility check. */
export function buildAdapterHealthService(pool: Pool): AdapterHealthService {
  return new AdapterHealthService(new AdapterConfigurationRepository(pool), new AdapterHealthCheckRepository(pool), new AdapterRegistryService());
}
