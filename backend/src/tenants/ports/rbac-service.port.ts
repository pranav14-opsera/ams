import type { PoolClient } from "pg";

export const RBAC_SERVICE = "RBAC_SERVICE";

export interface RbacServicePort {
  /** Inserts a baseline (empty-permission) row per platform role for a newly-provisioned tenant — WO-023 defines what those permissions actually are. */
  applyDefaultPolicies(tenantId: string, client?: PoolClient): Promise<void>;

  /** Union of every named role's permissions JSONB array (deduplicated). Genuinely returns [] today for every role until WO-023 (Five-Tier Permission Matrix) populates real grants — that's accurate current state, not a placeholder. */
  getPermissionsForRoles(tenantId: string, roles: string[]): Promise<string[]>;
}
