# Pre-commit scan — WO-070 (Enforce hard credit cap with agent pause)

## Scope
`HardCapEnforcementService`: when a team's real consumption reaches or
exceeds its hard cap, every active agent on that team is paused via
WO-032's own `LifecycleService`, with a critical alert and a full audit
trail; once consumption drops back below the cap, every agent this
mechanism itself paused is auto-resumed.

## Architectural decisions
- **Reconciles the two pre-existing "hard cap" concepts into one
  canonical value**, as flagged as this WO's own job back in WO-066/068's
  notes. `credit_budgets.hard_cap` (WO-068, finance-facing) is now the
  single source of truth; `CreditBudgetService.allocate` keeps
  `team_credit_limits.hard_cap` (WO-066, the real-time metering engine's
  own near-cap buffer) in sync with it on every allocation for the
  CURRENT period only — `team_credit_limits` has no period dimension at
  all (it's always "the live cap"), so a future/past-period allocation
  must never clobber it.
- **Pause enforcement is triggered from the reconciliation batch, not
  from `MeteringEngineService` directly** — same precedent as WO-069's
  own threshold monitoring hookup, and avoids a real module-dependency
  cycle (`CreditsModule` would otherwise need `HardCapEnforcementModule`,
  which itself needs `CreditBudgetModule`, which needs `CreditsModule`
  for the hard-cap sync). Reconciliation batches run frequently, keeping
  this well within the AC's 30-second pause bound.
- **Resume runs on its own 15-second scheduler poll**, not synchronously
  from `CreditBudgetService.allocate` — wiring `HardCapEnforcementModule`
  into `CreditBudgetModule` for that would create the same module cycle
  described above. A 15s tick comfortably clears the AC's 60-second
  resume bound.
- **`hard_cap_pause_state` tracks exactly which agents THIS mechanism
  paused**, distinct from `agents.lifecycle_status = 'paused'` alone —
  an agent an operator paused manually for an unrelated reason must
  never be auto-resumed just because the team's consumption later drops.
  Verified: a manually-paused agent stays paused through both an
  enforcement pass and a subsequent budget increase.
- **Per-agent alerting, not team-level** — unlike WO-067/069's own
  documented `alert_events.agent_id NOT NULL` mismatch (team-scoped
  events have no agent to attach to), a hard-cap pause is inherently
  agent-scoped (each paused agent gets its own critical `alert_events`
  row, `metric_name = "credit_hard_cap_reached"`), so this WO reuses
  WO-060's shared `AlertDeliveryService` pipeline directly with no
  workaround needed.
- **`MeteringEngineService`'s denial response now carries
  `hardCapReached`**, true whenever a denial's own CURRENT balance
  (not the would-be-projected balance) is already at or below zero —
  covers all three denial paths (cache peek, atomic-decrement TOCTOU,
  ledger fallthrough) via one shared check in `finish()`.
- **Zero-blast-radius optional DI throughout** — `CreditReconciliationService`,
  `CreditBudgetService`, and `HardCapEnforcementService` itself all take
  their new collaborators as optional constructor params; every existing
  call site/test that doesn't pass them keeps working unchanged.

## Verification
- `npm run typecheck` / `npm run build` — clean.
- `node scripts/verify-boot.js` — full DI graph resolves (confirms no
  module cycle between `CreditsModule` / `CreditBudgetModule` /
  `HardCapEnforcementModule` / `AgentsModule`).
- Unit tests: `hard-cap-enforcement.service.test.ts` (11 — reaches/exceeds
  cap pauses every active agent and skips already-paused ones, null cap
  and no-budget-configured are no-ops, per-agent pause failure isolation,
  zero-blast-radius without alert services, resume no-op/success/still-
  over-cap/never-touches-a-manually-retired-agent); 8 new tests in
  `metering-engine.service.test.ts` (`hardCapReached` true/false across
  cache-deny, atomic-decrement-deny, and ledger-fallthrough-deny paths,
  never true on an allow); 8 new tests in `credit-budget.service.test.ts`
  (current-period sync, null-cap sync, future-period no-op, zero-blast-
  radius, sync-failure-never-fails-allocation); 4 new tests in
  `credit-reconciliation.service.test.ts` (grouped-by-team trigger,
  no-trigger-on-empty-batch, one team's enforcement failure doesn't block
  threshold monitoring, zero blast radius).
- Real Postgres+Redis integration test
  (`hard-cap-enforcement-integration.test.ts`): two active agents + one
  manually-paused agent on a team; a real ledger debit brings consumption
  to exactly the hard cap; `enforceIfBreached` pauses both active agents
  (never touching the manually-paused one), persists two
  `hard_cap_pause_state` rows and two critical `alert_events` rows;
  re-running enforcement while still over the cap is a genuine no-op;
  raising the budget well above consumption and running the resume
  scheduler auto-resumes exactly the two auto-paused agents, clears their
  pause-state rows, and leaves the manually-paused agent untouched.
- Full regression: `test/credits/**`, `test/agents/**` — all passing, 0
  failing, against real local Postgres + Redis.
- Security: gitleaks (7 findings, all pre-existing test fixtures —
  `encryption-sample-payloads.json`, `saml-idp-keypair.ts`,
  `jwt-fixtures.json` — none touched by this WO); semgrep (0 findings);
  `npm audit --omit=dev` (0 vulnerabilities).

## Known gap
Lowering a team's hard cap to below current consumption is synced into
`team_credit_limits` immediately, but pause enforcement for that team
only re-runs on the next reconciliation batch (not synchronously inside
`allocate`) — same reasoning as the resume path (avoiding the
`CreditBudgetModule` <-> `HardCapEnforcementModule` cycle). Still well
within the AC's 30-second bound in practice given batch frequency.
