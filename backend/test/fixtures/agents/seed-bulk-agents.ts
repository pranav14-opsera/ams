import type { Pool } from "pg";
import { AgentsService } from "../../../src/agents/agents.service";
import { LifecycleService } from "../../../src/agents/lifecycle.service";
import type { AgentFramework } from "../../../src/agents/dto/create-agent.dto";

export interface SeededBulkAgents {
  teamIds: string[];
  agentIds: string[];
}

/**
 * Seeds 54 real agents (via AgentsService.create + genuine
 * LifecycleService.transition calls, not bare column updates) across 3
 * teams, satisfying this WO's own fixture requirement of "50+ agents in
 * various lifecycle states to support bulk operation testing." Half start
 * Active (so a bulk Active->Paused request has real work to do); the rest
 * are spread across Connecting/Paused/Retired/Decommissioned so a bulk
 * request against the whole set naturally produces a mix of valid and
 * invalid transitions for a given target status.
 */
export async function seedBulkAgents(pool: Pool, service: AgentsService, lifecycleService: LifecycleService, tenantId: string): Promise<SeededBulkAgents> {
  const teamNames = ["Bulk Team Alpha", "Bulk Team Beta", "Bulk Team Gamma"];
  const teamIds: string[] = [];
  for (const name of teamNames) {
    const result = await pool.query("INSERT INTO teams (tenant_id, name) VALUES ($1, $2) RETURNING id", [tenantId, name]);
    teamIds.push(result.rows[0].id);
  }

  const frameworks: AgentFramework[] = ["langchain", "crewai", "autogen", "generic_rest"];
  const agentIds: string[] = [];

  for (let i = 0; i < 54; i++) {
    const created = await service.create(pool, tenantId, null, {
      name: `Bulk Agent ${i + 1}`,
      framework: frameworks[i % frameworks.length],
      teamId: teamIds[i % teamIds.length],
      connectionConfig: { apiKey: `bulk-fixture-key-${i}` },
    });
    agentIds.push(created.id);

    const bucket = i % 5;
    if (bucket === 0) continue; // stays Connecting
    await lifecycleService.transition(pool, tenantId, null, created.id, "active", undefined);
    if (bucket === 1) continue; // stays Active
    if (bucket === 2) {
      await lifecycleService.transition(pool, tenantId, null, created.id, "paused", undefined);
    } else if (bucket === 3) {
      await lifecycleService.transition(pool, tenantId, null, created.id, "retired", "fixture: retired for bulk test coverage");
    } else if (bucket === 4) {
      await lifecycleService.transition(pool, tenantId, null, created.id, "retired", "fixture: retired for bulk test coverage");
      await lifecycleService.transition(pool, tenantId, null, created.id, "decommissioned", "fixture: decommissioned for bulk test coverage");
    }
  }

  return { teamIds, agentIds };
}
