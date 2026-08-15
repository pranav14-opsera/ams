# Role-Aware Sidebar Navigation (WO-051)

## Architecture

- `src/types/navigation.ts` — `NavigationItem`: a recursive tree node. A group header (e.g. "Agent Management") has `children` and an empty `requiredPermissions`; a leaf item has `href` and a real permission list, no children.
- `src/config/navigation.ts` — `NAVIGATION_CONFIG`, the single source of truth for every menu item across all 5 roles, organized into 6 groups (Agent Management, Analytics, Finance, Governance, Compliance, Settings).
- `src/hooks/usePermissions.ts` — `filterNavigationByPermissions(items, grantedPermissions)`, the pure, independently-unit-tested filtering function, plus the `usePermissions()` hook that reads the caller's permissions from the Zustand auth store.
- `src/hooks/useSidebarState.ts` / `useMediaQuery.ts` — collapsed/expanded-groups/mobile-drawer state, persisted to `localStorage`, plus the 768px breakpoint detector.
- `src/components/navigation/{sidebar,sidebar-group,sidebar-item,mobile-drawer}.tsx` — the rendering layer.

## OWASP A01: this is a UX affordance, never the access control

`filterNavigationByPermissions` removes unauthorized items from the DOM entirely (never CSS `display:none`) — but per this WO's own AC, **every route behind these menu items must independently be protected by the backend's own `RbacGuard`** (already this platform's deny-by-default gate, WO-019/023/024). A permission omitted from `NAVIGATION_CONFIG` never implies the corresponding page is safe to leave unguarded — the two are deliberately decoupled, and this doc is not a substitute for verifying the actual route guard exists.

## Permission fixtures are the REAL RBAC matrix, not invented strings

`src/test/fixtures/permissions/{admin,team-lead,operator,finance,compliance}.json` are copied **exactly** from migration 024's seed data (`database/migrations/024_rbac_permission_matrix.sql`) / `rbac.constants.ts` — every permission string a real backend role actually holds today, not a plausible-looking placeholder. This matters because `NAVIGATION_CONFIG`'s `requiredPermissions` values must line up with what the server will genuinely send back in a JWT/session's permission claims (WO-019/023) — a mismatch here would either wrongly hide a menu item a role does have access to, or wrongly show one it doesn't.

## Known gaps: menu items with no dedicated 1:1 permission yet

The AC specifies exact menu labels per role (e.g. "Health Dashboard", "ABAC Policies", "Budget Review", "Agent Performance", "Agent Status") that don't all have a bespoke permission in the current RBAC matrix (migration 024) — that matrix was designed around the 5 roles' overall responsibilities, not this specific navigation layout. Rather than inventing new permission strings the backend has never granted (which would either always hide the item, since no role holds a permission that doesn't exist, or require a speculative backend migration this WO doesn't own), each such item reuses the **closest existing** real permission already granted to that role, documented inline in `navigation.ts`:

| Menu item | Role | Reused permission | Why |
|---|---|---|---|
| Health Dashboard | Platform Admin | `agent_management:agent:read` | No dedicated health-monitoring permission exists yet |
| ABAC Policies | Platform Admin | `governance:policy:configure` | No dedicated ABAC permission exists yet — governance policy is the closest existing grant |
| Agent Status | Agent Operator | `agent_management:agent:trigger` | Operator's only agent-level permission besides trace viewing |
| Budget Review | Team Lead | `credit_management:consumption:view_team` | No team-scoped budget-review permission exists; team_lead has no `budget:configure` (finance_manager-only) |
| Agent Performance | Team Lead | `agent_management:agent:read` | No dedicated performance-metrics permission exists yet |

If a future WO adds finer-grained permissions for these specific capabilities (a natural follow-up to WO-023's own permission matrix), `navigation.ts`'s `requiredPermissions` for these five items should be updated to point at the new, more precise permission rather than continuing to reuse the current stand-in.

## Testing

- **Unit** (`usePermissions.test.ts`): all 5 role fixtures verified for correct inclusion/exclusion, plus edge cases — empty permission set, an unknown permission string, a group with only some children authorized (group survives, only the authorized children remain), and OR-semantics across a leaf's multiple acceptable permissions (Trace Explorer: admin's `view_all` OR operator's `view_assigned`).
- **Component** (`sidebar-item.test.tsx`, `sidebar-group.test.tsx`, `mobile-drawer.test.tsx`): active-route `aria-current`, collapsed-mode label hiding, badge rendering, `aria-expanded` toggling, Radix Dialog's own focus-trap/Escape/overlay-close defaults.
- **E2E** (`tests/e2e/sidebar.spec.ts`): a real Playwright browser against the **built static export**, seeded with a mocked role via one dedicated `localStorage` key (`__ams_e2e_auth_override__`) that `app-store.ts` reads on initialization — nothing else in the app ever writes this key, so a real user session is unaffected. Covers desktop rendering for the admin role, an unauthenticated empty-nav case, mobile drawer open/close (button + Escape), and keyboard navigation (Tab to a group trigger, Enter to expand).
- **Accessibility** (`tests/e2e/sidebar-accessibility.spec.ts`): axe-core against 4 explicit modes the AC calls out by name — desktop expanded, desktop collapsed (icon-only), mobile drawer open, and unauthenticated/empty — all zero critical violations. This is distinct from WO-009's own `scan-all-routes.ts`, which only exercises each static route in its default (un-authenticated, un-interacted) state and wouldn't otherwise reach the drawer-open or collapsed-sidebar states at all.

## A real bug found via testing: `serve`'s concurrency limits

Running the Playwright suite with its default parallel workers produced `net::ERR_ABORTED` on nearly every test — not a real navigation bug, but `serve` (the lightweight static file server backing `webServer` in `playwright.config.ts`) dropping connections under concurrent load from multiple browser contexts. Confirmed by re-running with `--workers=1`: all tests passed immediately. Fixed by setting `workers: 1` / `fullyParallel: false` in `playwright.config.ts` — this suite is small enough that serializing it costs seconds, not minutes, and it's more honest than working around a tooling limitation with retries.
