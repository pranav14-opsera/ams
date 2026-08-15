import type { AgentRow } from "./agents.repository";

export interface AgentResource {
  id: string;
  tenantId: string;
  teamId: string | null;
  name: string;
  framework: string;
  lifecycleStatus: string;
  metadata: Record<string, unknown>;
  version: number;
  registeredAt: string;
  updatedAt: string;
}

/**
 * Connection credentials are deliberately NEVER included in any API
 * response, not even decrypted-and-redacted — this WO's own acceptance
 * criteria list the fields a create/get response contains, and
 * connection_config is not one of them. Same "write-only credential"
 * convention as WO-018's SsoConfigController never returning
 * oidcClientSecret.
 */
export function toAgentResource(row: AgentRow): AgentResource {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    teamId: row.team_id,
    name: row.name,
    framework: row.framework,
    lifecycleStatus: row.lifecycle_status,
    metadata: row.metadata,
    version: row.version,
    registeredAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
