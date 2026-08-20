import type { ConnectionValidationResult } from "./connection-validation.service";
import type { AgentRow } from "./agents.repository";

export interface AgentTeamRef {
  id: string;
  name: string;
}

export interface AppliedPolicies {
  rbac: string[];
  creditBudget: { amount: number; currency: string } | null;
}

export interface AgentResource {
  id: string;
  tenantId: string;
  teamId: string | null;
  /** Populated only when the row came from AgentsRepository.findAll's own LEFT JOIN — null for every other lookup path (findOne, create, update), same as `lastSeen` never being present without a real `updated_at`. */
  team: AgentTeamRef | null;
  name: string;
  framework: string;
  lifecycleStatus: string;
  /**
   * WO-079's Agent Registry AC needs a "Last Seen" column/sort key. No
   * dedicated heartbeat/telemetry-derived timestamp column exists on
   * `agents` yet (telemetry lands in agent_metrics, keyed by agent_id with
   * no per-agent "latest" projection maintained today) — using the row's
   * own `updated_at` (bumped on every lifecycle transition and field
   * update) as the closest real proxy. A dedicated `last_seen_at` column
   * fed by the telemetry/heartbeat path is a natural follow-up, not
   * invented here since it's outside this WO's own scope (a UI page, not a
   * new telemetry pipeline).
   */
  lastSeen: string;
  metadata: Record<string, unknown>;
  version: number;
  registeredAt: string;
  updatedAt: string;
  /**
   * WO-080 Step 4/api_contracts' `connectionValidation` field —
   * ConnectionValidationService's own fire-and-forget outcome, read back
   * from `metadata.connectionValidation` (see that service's own docstring
   * for why this rides on the existing flexible metadata column rather
   * than a new lifecycle status). Defaults to "pending" until that
   * background write lands.
   */
  connectionValidation: ConnectionValidationResult;
  /**
   * WO-080 success-screen AC ("applied RBAC policies and credit budget") —
   * populated only by AgentsService.findOne (the wizard's own Step 4 poll
   * target), not by findAll/create, to avoid an extra RBAC+budget lookup
   * on every paginated registry-table row.
   */
  appliedPolicies?: AppliedPolicies;
}

/**
 * Connection credentials are deliberately NEVER included in any API
 * response, not even decrypted-and-redacted — this WO's own acceptance
 * criteria list the fields a create/get response contains, and
 * connection_config is not one of them. Same "write-only credential"
 * convention as WO-018's SsoConfigController never returning
 * oidcClientSecret.
 */
function toConnectionValidation(row: AgentRow): ConnectionValidationResult {
  const recorded = row.metadata?.connectionValidation as ConnectionValidationResult | undefined;
  if (recorded && typeof recorded === "object" && typeof recorded.status === "string") return recorded;
  if (row.lifecycle_status === "active") return { status: "success", message: "Connection validated successfully.", completedAt: row.updated_at.toISOString() };
  return { status: "pending", message: null, completedAt: null };
}

export function toAgentResource(row: AgentRow): AgentResource {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    teamId: row.team_id,
    team: row.team_id ? { id: row.team_id, name: row.team_name ?? "" } : null,
    name: row.name,
    framework: row.framework,
    lifecycleStatus: row.lifecycle_status,
    lastSeen: row.updated_at.toISOString(),
    metadata: row.metadata,
    version: row.version,
    registeredAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    connectionValidation: toConnectionValidation(row),
  };
}
