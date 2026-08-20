import {
  Activity,
  BarChart3,
  Bell,
  BookOpen,
  ClipboardList,
  DollarSign,
  FileSearch,
  FileText,
  Gauge,
  Landmark,
  LayoutDashboard,
  ListTree,
  Receipt,
  ScrollText,
  Server,
  Settings,
  ShieldCheck,
  TrendingUp,
  UserCog,
  Wallet,
} from "lucide-react";
import type { NavigationItem } from "@/types/navigation";

// WO-051's navigation config, per-role menu items straight from this WO's
// own AC. Every requiredPermissions entry is a REAL permission from the
// backend RBAC matrix (migration 024 / rbac.constants.ts) — never
// invented — matched to the closest existing grant when the AC's menu
// label doesn't have a dedicated 1:1 permission yet (documented per-item
// below and in NAVIGATION.md). OWASP A01: this list only controls what
// renders in the DOM; every one of these routes must ALSO be protected by
// a server-side route guard (RbacGuard, already the platform's own
// deny-by-default gate) — hiding a menu item is never itself the access
// control.
export const NAVIGATION_CONFIG: NavigationItem[] = [
  {
    id: "agent-management",
    label: "Agent Management",
    icon: Server,
    requiredPermissions: [],
    children: [
      { id: "agent-registry", label: "Agent Registry", icon: ListTree, href: "/agents/registry", requiredPermissions: ["agent_management:agent:read"] },
      { id: "lifecycle", label: "Lifecycle", icon: Activity, href: "/agents/lifecycle", requiredPermissions: ["agent_management:agent:lifecycle_control"] },
      // No dedicated "health dashboard" permission exists yet in the RBAC
      // matrix — reuses agent:read, the closest existing read-level grant.
      { id: "health-dashboard", label: "Health Dashboard", icon: Gauge, href: "/agents/health", requiredPermissions: ["agent_management:agent:read"] },
      { id: "agent-status", label: "Agent Status", icon: Activity, href: "/agents/status", requiredPermissions: ["agent_management:agent:trigger"] },
      {
        id: "trace-explorer",
        label: "Trace Explorer",
        icon: FileSearch,
        href: "/agents/traces",
        requiredPermissions: ["agent_management:trace:view_all", "agent_management:trace:view_assigned"],
      },
      {
        id: "agent-performance",
        label: "Agent Performance",
        icon: BarChart3,
        href: "/agents/performance",
        requiredPermissions: ["agent_management:agent:read"],
      },
    ],
  },
  {
    id: "analytics",
    label: "Analytics",
    icon: BarChart3,
    requiredPermissions: [],
    children: [
      {
        // WO-075: this slot pre-dated the team usage dashboard's own
        // implementation (same "placeholder href gets pointed at the
        // real route" pattern WO-074 already used for
        // consumption-dashboard below) — points at the real
        // `/dashboard/usage/team` route instead of the placeholder
        // `/analytics/team` page that never existed. requiredPermissions
        // widened to an OR of view_org/view_team so a Platform
        // Administrator (view_org only) sees this entry too, matching
        // AC 1's "accessible to Team Lead (own team only) and Platform
        // Administrator (all teams)".
        id: "team-dashboard",
        label: "Team Dashboard",
        icon: LayoutDashboard,
        href: "/dashboard/usage/team",
        requiredPermissions: ["credit_management:consumption:view_org", "credit_management:consumption:view_team"],
      },
      {
        id: "personal-dashboard",
        label: "Personal Dashboard",
        icon: LayoutDashboard,
        href: "/analytics/personal",
        requiredPermissions: ["credit_management:consumption:view_personal"],
      },
      {
        // WO-074: this slot pre-dated the org usage dashboard's own
        // implementation — its href now points at the real route
        // (`/dashboard/usage/org`, per this WO's own literal AC) instead
        // of the placeholder `/analytics/consumption` page that never
        // existed. requiredPermissions widened to an OR of view_org/
        // view_team (filterNavigationByPermissions' own `.some(...)`
        // semantics) to match the AC's "Platform Administrator or Team
        // Lead" access rule — team_lead only ever held view_team, never
        // view_org.
        id: "consumption-dashboard",
        label: "Organization Usage Dashboard",
        icon: TrendingUp,
        href: "/dashboard/usage/org",
        requiredPermissions: ["credit_management:consumption:view_org", "credit_management:consumption:view_team"],
      },
      {
        id: "usage-analytics",
        label: "Usage Analytics",
        icon: BarChart3,
        href: "/analytics/usage",
        requiredPermissions: ["credit_management:consumption:view_team"],
      },
      {
        id: "credit-balance",
        label: "Credit Balance",
        icon: Wallet,
        href: "/analytics/credit-balance",
        requiredPermissions: ["credit_management:consumption:view_personal"],
      },
      { id: "forecast", label: "Forecast", icon: TrendingUp, href: "/analytics/forecast", requiredPermissions: ["credit_management:forecast:view"] },
    ],
  },
  {
    id: "finance",
    label: "Finance",
    icon: DollarSign,
    requiredPermissions: [],
    children: [
      // No dedicated team-scoped "budget review" permission exists yet —
      // team_lead's own consumption:view_team is the closest existing
      // read-level grant for this AC item.
      {
        id: "budget-review",
        label: "Budget Review",
        icon: Receipt,
        href: "/finance/budget-review",
        requiredPermissions: ["credit_management:consumption:view_team"],
      },
      {
        id: "budget-management",
        label: "Budget Management",
        icon: Landmark,
        href: "/finance/budget",
        requiredPermissions: ["credit_management:budget:configure"],
      },
      {
        id: "billing-reports",
        label: "Billing Reports",
        icon: FileText,
        href: "/finance/billing-reports",
        requiredPermissions: ["reporting:consumption_report:generate"],
      },
    ],
  },
  {
    id: "governance",
    label: "Governance",
    icon: ShieldCheck,
    requiredPermissions: [],
    children: [
      { id: "rbac-editor", label: "RBAC Editor", icon: UserCog, href: "/governance/rbac", requiredPermissions: ["tenant_configuration:rbac:manage"] },
      // No dedicated ABAC permission exists in the current matrix — reuses
      // the general governance:policy:configure grant (see NAVIGATION.md).
      { id: "abac-policies", label: "ABAC Policies", icon: ScrollText, href: "/governance/abac", requiredPermissions: ["governance:policy:configure"] },
      { id: "governance-rules", label: "Governance Rules", icon: BookOpen, href: "/governance/rules", requiredPermissions: ["governance:policy:configure"] },
      { id: "alert-config", label: "Alert Config", icon: Bell, href: "/governance/alerts", requiredPermissions: ["reporting:team_alert:configure"] },
    ],
  },
  {
    id: "compliance",
    label: "Compliance",
    icon: ClipboardList,
    requiredPermissions: [],
    children: [
      { id: "audit-logs", label: "Audit Logs", icon: FileText, href: "/compliance/audit-logs", requiredPermissions: ["audit_access:logs:view_org"] },
      {
        id: "audit-log-explorer",
        label: "Audit Log Explorer",
        icon: FileSearch,
        href: "/compliance/audit-explorer",
        requiredPermissions: ["audit_access:logs:view_org"],
      },
      {
        id: "phi-access-monitor",
        label: "PHI Access Monitor",
        icon: ShieldCheck,
        href: "/compliance/phi-monitor",
        requiredPermissions: ["audit_access:phi_monitoring:view"],
      },
      {
        id: "data-retention",
        label: "Data Retention",
        icon: ScrollText,
        href: "/compliance/data-retention",
        requiredPermissions: ["data_retention:policy:manage"],
      },
      { id: "dsr-tracking", label: "DSR Tracking", icon: ClipboardList, href: "/compliance/dsr", requiredPermissions: ["data_retention:dsr:track"] },
      {
        id: "compliance-reports",
        label: "Compliance Reports",
        icon: FileText,
        href: "/compliance/reports",
        requiredPermissions: ["reporting:compliance_report:generate"],
      },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    icon: Settings,
    requiredPermissions: [],
    children: [
      { id: "tenant-config", label: "Tenant Config", icon: Settings, href: "/settings/tenant", requiredPermissions: ["tenant_configuration:settings:manage"] },
    ],
  },
];
