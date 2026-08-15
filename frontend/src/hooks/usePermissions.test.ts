import { describe, expect, it } from "vitest";
import { NAVIGATION_CONFIG } from "@/config/navigation";
import adminPermissions from "@/test/fixtures/permissions/admin.json";
import teamLeadPermissions from "@/test/fixtures/permissions/team-lead.json";
import operatorPermissions from "@/test/fixtures/permissions/operator.json";
import financePermissions from "@/test/fixtures/permissions/finance.json";
import compliancePermissions from "@/test/fixtures/permissions/compliance.json";
import { filterNavigationByPermissions } from "./usePermissions";

function allItemIds(items: ReturnType<typeof filterNavigationByPermissions>): string[] {
  return items.flatMap((item) => [item.id, ...(item.children ? allItemIds(item.children) : [])]);
}

describe("filterNavigationByPermissions", () => {
  it("platform_admin sees every AC-specified admin menu item", () => {
    const ids = allItemIds(filterNavigationByPermissions(NAVIGATION_CONFIG, adminPermissions));
    for (const expected of [
      "agent-registry",
      "lifecycle",
      "health-dashboard",
      "rbac-editor",
      "abac-policies",
      "tenant-config",
      "audit-logs",
      "governance-rules",
    ]) {
      expect(ids).toContain(expected);
    }
  });

  it("team_lead sees only their own menu items — never admin-only items like RBAC Editor or Tenant Config", () => {
    const ids = allItemIds(filterNavigationByPermissions(NAVIGATION_CONFIG, teamLeadPermissions));
    for (const expected of ["team-dashboard", "usage-analytics", "budget-review", "agent-performance", "alert-config"]) {
      expect(ids).toContain(expected);
    }
    for (const forbidden of ["rbac-editor", "tenant-config", "budget-management", "phi-access-monitor"]) {
      expect(ids).not.toContain(forbidden);
    }
  });

  it("agent_operator sees only their own menu items", () => {
    const ids = allItemIds(filterNavigationByPermissions(NAVIGATION_CONFIG, operatorPermissions));
    for (const expected of ["personal-dashboard", "agent-status", "trace-explorer", "credit-balance"]) {
      expect(ids).toContain(expected);
    }
    for (const forbidden of ["rbac-editor", "team-dashboard", "audit-logs"]) {
      expect(ids).not.toContain(forbidden);
    }
  });

  it("finance_manager sees only their own menu items — never agent lifecycle or RBAC", () => {
    const ids = allItemIds(filterNavigationByPermissions(NAVIGATION_CONFIG, financePermissions));
    for (const expected of ["consumption-dashboard", "budget-management", "forecast", "billing-reports"]) {
      expect(ids).toContain(expected);
    }
    for (const forbidden of ["lifecycle", "rbac-editor", "agent-registry"]) {
      expect(ids).not.toContain(forbidden);
    }
  });

  it("compliance_officer sees only their own menu items — never agent lifecycle or credit management", () => {
    const ids = allItemIds(filterNavigationByPermissions(NAVIGATION_CONFIG, compliancePermissions));
    for (const expected of ["audit-log-explorer", "phi-access-monitor", "data-retention", "dsr-tracking", "compliance-reports"]) {
      expect(ids).toContain(expected);
    }
    for (const forbidden of ["budget-management", "lifecycle", "rbac-editor"]) {
      expect(ids).not.toContain(forbidden);
    }
  });

  it("edge case: an empty permission set filters out everything (no groups, no items)", () => {
    const filtered = filterNavigationByPermissions(NAVIGATION_CONFIG, []);
    expect(filtered).toEqual([]);
  });

  it("edge case: an unknown permission that matches nothing in the config filters out everything", () => {
    const filtered = filterNavigationByPermissions(NAVIGATION_CONFIG, ["some_unknown:permission:string"]);
    expect(filtered).toEqual([]);
  });

  it("edge case: a nested group with only SOME children authorized keeps the group but only the authorized children", () => {
    // team_lead holds agent_management:agent:read (Agent Registry) but not
    // agent_management:agent:lifecycle_control (Lifecycle) — the group
    // itself must survive (Agent Registry authorized) while Lifecycle is filtered out.
    const filtered = filterNavigationByPermissions(NAVIGATION_CONFIG, teamLeadPermissions);
    const agentGroup = filtered.find((g) => g.id === "agent-management");
    expect(agentGroup).toBeDefined();
    const childIds = agentGroup!.children!.map((c) => c.id);
    expect(childIds).toContain("agent-registry");
    expect(childIds).not.toContain("lifecycle");
  });

  it("a leaf item is visible if it matches ANY of multiple required permissions (OR semantics)", () => {
    // Trace Explorer requires EITHER trace:view_all (admin) OR trace:view_assigned (operator).
    const adminIds = allItemIds(filterNavigationByPermissions(NAVIGATION_CONFIG, adminPermissions));
    const operatorIds = allItemIds(filterNavigationByPermissions(NAVIGATION_CONFIG, operatorPermissions));
    expect(adminIds).toContain("trace-explorer");
    expect(operatorIds).toContain("trace-explorer");
  });
});
