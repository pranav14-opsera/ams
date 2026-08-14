import { Injectable } from "@nestjs/common";
import type { RbacServicePort } from "../rbac-service.port";

const DEFAULT_ROLES = ["platform_admin", "compliance_officer", "finance_manager", "team_lead", "agent_operator"] as const;

@Injectable()
export class InMemoryRbacService implements RbacServicePort {
  readonly appliedTenantIds: string[] = [];

  async applyDefaultPolicies(tenantId: string): Promise<void> {
    this.appliedTenantIds.push(tenantId);
  }
}

export { DEFAULT_ROLES };
