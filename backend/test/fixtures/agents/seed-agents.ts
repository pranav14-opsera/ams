import type { Pool } from "pg";
import { AgentsService } from "../../../src/agents/agents.service";
import type { AgentFramework } from "../../../src/agents/dto/create-agent.dto";

export interface SeededAgentTenants {
  tenantAId: string;
  tenantBId: string;
  teamIds: string[];
}

/**
 * Seeds 12 real agent records (via AgentsService.create — genuine BYOK
 * encryption, real audit events, exactly the path the API itself uses)
 * across 2 tenants and 3 teams, covering every framework type and a mix
 * of lifecycle statuses (via an explicit status update after creation
 * for the ones that shouldn't stay 'connecting') — satisfies this WO's
 * "at least 10 agent records across 2 tenants and 3 teams with varied
 * framework types and lifecycle statuses" fixture requirement as a real,
 * runnable seed rather than a static description.
 */
export async function seedAgents(pool: Pool, service: AgentsService, tenantAId: string, tenantBId: string): Promise<SeededAgentTenants> {
  const teamNames = ["Support", "Billing", "Operations"];
  const teamIds: string[] = [];
  for (const name of teamNames) {
    const result = await pool.query("INSERT INTO teams (tenant_id, name) VALUES ($1, $2) RETURNING id", [tenantAId, name]);
    teamIds.push(result.rows[0].id);
  }

  const frameworks: AgentFramework[] = ["langchain", "crewai", "autogen", "generic_rest"];

  // 9 agents for tenant A, spread across the 3 teams and 4 frameworks.
  for (let i = 0; i < 9; i++) {
    const created = await service.create(pool, tenantAId, null, {
      name: `Tenant A Agent ${i + 1}`,
      framework: frameworks[i % frameworks.length],
      teamId: teamIds[i % teamIds.length],
      connectionConfig: { apiKey: `fixture-key-${i}` },
    });
    if (i % 3 === 1) await pool.query("UPDATE agents SET lifecycle_status = 'active' WHERE id = $1", [created.id]);
    if (i % 3 === 2) await pool.query("UPDATE agents SET lifecycle_status = 'paused' WHERE id = $1", [created.id]);
  }

  // 3 agents for tenant B, proving cross-tenant isolation has real data to isolate.
  for (let i = 0; i < 3; i++) {
    await service.create(pool, tenantBId, null, {
      name: `Tenant B Agent ${i + 1}`,
      framework: frameworks[i % frameworks.length],
      connectionConfig: { apiKey: `fixture-key-b-${i}` },
    });
  }

  return { tenantAId, tenantBId, teamIds };
}
