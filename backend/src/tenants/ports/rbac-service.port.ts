import type { PoolClient } from "pg";

export const RBAC_SERVICE = "RBAC_SERVICE";

export interface RbacServicePort {
  /** Inserts a baseline (empty-permission) row per platform role for a newly-provisioned tenant — WO-023 defines what those permissions actually are. */
  applyDefaultPolicies(tenantId: string, client?: PoolClient): Promise<void>;
}
