# Pre-commit scan — WO-068 (Credit budget allocation API for teams)

## Scope
`CreditBudgetService`: allocate/view team credit budgets drawn from an
organization-wide, per-period pool. `POST /api/v1/credits/allocate`,
`GET /api/v1/credits/budgets`, `GET /api/v1/credits/budgets/:teamId`, with
RBAC enforcement (Finance Manager/Platform Admin for mutation, Team
Lead/Agent Operator for their own team's read) and audited allocation
changes.

## Architectural decisions
- **Pool-capacity enforcement via a real row lock, not application-level
  re-reads.** `allocate()` acquires its own connection, `SELECT ...
  FOR UPDATE`s the `organization_credit_pools` row for the tenant+period
  (the serialization point), sums every OTHER team's current allocation,
  and only commits if the new/updated total still fits. Verified against
  real Postgres with 3 genuinely concurrent 500-credit requests against a
  1000-credit pool: exactly 2 succeed, 1 is rejected, and the real final
  sum never exceeds the pool — a plain "read sum, then check, then write"
  without the lock would have a real race window here.
- **Updating an existing team's own allocation excludes its OWN current
  value from the pool-capacity check** — otherwise a team could never
  increase its allocation even when the pool has room, since its old
  allocation would double-count against the new one.
- **RbacGuard's existing `@ResourceTeamParam` mechanism reused, not
  reinvented** — `resource-team-param.decorator.ts`'s own doc comment
  explicitly named credit management as one of the "later work orders"
  it was built for. `GET /budgets/:teamId` combines
  `@RequireAnyPermission([...VIEW_ORG, ...VIEW_TEAM, ...VIEW_PERSONAL])`
  with `@ResourceTeamParam("teamId")`: org-level roles pass for any team,
  team-scoped roles (team_lead/agent_operator) are automatically denied
  for any team they don't actually belong to — no custom scoping logic
  needed in the controller/service at all. Verified against real
  Postgres+RbacGuard (same testing convention as the existing audit-log
  RBAC test) across all 4 role combinations the AC lists.
- **Pool provisioning has no dedicated HTTP endpoint in this WO.** The AC's
  own endpoint list is only `POST /allocate` + the two `GET /budgets`
  routes — nothing for creating/topping-up the organization's own pool.
  `CreditBudgetRepository.upsertPool` exists (used by tests and available
  to a future billing-integration WO) but isn't exposed publicly here;
  `allocate()` returns a clear 400 ("No organization credit pool is
  configured...") if none exists yet for the period, rather than silently
  fabricating an unlimited pool.
- **`hard_cap` on `credit_budgets` is intentionally a separate column
  from WO-066's own `team_credit_limits.hard_cap`.** WO-066 already reads
  a parallel "hard cap" concept for its own near-cap metering fallthrough
  (a fast-path, cache-refresh-oriented value); this one is the finance-
  facing budget record. Reconciling the two into a single source of truth
  is explicitly WO-070's ("Hard Cap Enforcement") own scope, not this
  one's — documented in the migration's own comment.
- **`consumedCredits` is budget-PERIOD-scoped gross debits**
  (`SUM(credits_debit)` within `[monthStart, monthEnd)`), distinct from
  WO-065's ledger `running_balance`/net-balance concept (lifetime, not
  period-scoped). **`projectedExhaustionDate`** is null (not a fabricated
  date) when the trailing-30-day daily average is 0 — there's no
  meaningful trend to project from.

## Verification
- `npm run typecheck` / `npm run build` — clean.
- `node scripts/verify-boot.js` — full DI graph resolves.
- Unit tests: `credit-budget.service.test.ts` (9 — valid allocation,
  over-allocation rejection, self-exclusion on update, no-pool-configured
  rejection, transaction rollback verification, consumption/remaining/
  percentage computation, not-found, null-percentage-on-zero-allocation,
  null-projection-on-zero-trend).
- Real Postgres integration tests
  (`credit-budget-integration.test.ts`, 3 tests): allocation validated
  against a real pool with real persisted audit events; 3 genuinely
  concurrent over-the-pool allocation attempts correctly serialized (only
  2 of 3 succeed, real final sum never exceeds the pool); `getTeamBudget`
  reflects real ledger consumption for the period.
- Real Postgres RBAC integration tests
  (`credit-budget-rbac-integration.test.ts`, 2 tests, same convention as
  the existing audit-log RBAC test): org roles pass for any team,
  team_lead passes for their own team and is denied (cross_team_access)
  for another team, an unauthorized role is denied outright; POST
  /allocate denies a Team Lead and allows a Finance Manager.
- Committed fixtures (`credit-budgets.fixture.ts`, deterministic — 3
  tenants with varying pool sizes, 5 team budgets sized to fit within
  their own tenant's pool) exercised by a dedicated integration test
  seeding and validating all of them against real Postgres.
- Full regression: `test/credits`, `test/tenants`, `test/rbac` — 129
  passing, 0 failing.
- Security: gitleaks (1 finding — the same already-documented recharts
  false positive), semgrep (0 findings), `npm audit` (0 vulnerabilities).
