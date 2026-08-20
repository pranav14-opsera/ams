# WO-081 Reconciliation — Agent Lifecycle Management UI with Bulk Operations

Branch: `feat/wo-081-lifecycle-management-ui` (based on `main` @ ef4dc0d, WO-080).
Scope: frontend only. No backend changes were needed — confirmed below.

## Backend: no changes needed (confirmed, not assumed)

Read `backend/src/agents/lifecycle-state-machine.ts`, `lifecycle.service.ts`,
`bulk-lifecycle.service.ts`, `agents.controller.ts`, and their DTOs
(`lifecycle-transition.dto.ts`, `bulk-lifecycle.dto.ts`) in full. All of
WO-081's backend-facing requirements were already built in WO-032/033:

- `PATCH /api/v1/agents/:id/lifecycle` and `POST /api/v1/agents/bulk-lifecycle`
  already exist, RBAC-gated (`AGENT_LIFECYCLE_CONTROL` /
  `AGENT_BULK_LIFECYCLE_CONTROL`).
- State machine, in-flight-operation draining (Active->Paused), audit log
  entries (`agent.lifecycle_transition`), and the `/ws/health`
  `agent_status_update` push all already exist in `LifecycleService.transition`.
- `BulkLifecycleService.execute` already does per-agent success/failure
  reporting, bounded concurrency, and a 30s timeout budget.
- Existing backend test suites already cover all of this
  (`test/agents/lifecycle-state-machine.test.ts`,
  `lifecycle.service.test.ts`, `lifecycle-integration.test.ts`,
  `bulk-lifecycle.service.test.ts`, `bulk-lifecycle-integration.test.ts`).

`git status` on `backend/` is clean — zero files touched.

## Important divergence from the WO's own literal `api_contracts` — trust the code, not the prose

The WO's own `api_contracts` field describes a body shape of
`{ action: 'pause'|... }` for the PATCH and `{ agentIds, action }` for the
bulk POST, with different response shapes than what's actually implemented.
Per this WO's own briefing ("trust the actual code's state machine, not the
prose summary"), the frontend was built against the **real** backend
contract, confirmed by reading the DTOs and controller directly:

- `PATCH /api/v1/agents/{id}/lifecycle` body: `{ targetStatus, justification? }`
  (a lifecycle status value like `"paused"`, not an action verb like
  `"pause"`). Response: the updated `AgentResource` plus `warning`.
- `POST /api/v1/agents/bulk-lifecycle` body: `{ agentIds, targetStatus,
  justification? }` (or `{ filter, targetStatus }` — not used by this UI,
  which always sends explicit `agentIds`). Response:
  `{ totalCount, successCount, failureCount, results: [{ agentId, status,
  previousStatus, newStatus, warning, error }] }` — no `agentName` per
  result, so the UI carries its own `agentId -> name` map from the
  selection it already held.
- Bulk batch max is 100 (`MAX_BULK_BATCH_SIZE`), not 50 as the WO's prose
  said — the UI does not hard-code a client-side cap; the server enforces it
  and a 400 surfaces as a `BulkLifecycleError`.

Documented in code comments at the point of use (types/dashboard.ts,
useLifecycleTransitionMutation.ts, useBulkLifecycleMutation.ts).

## Client-side state machine: narrower than the backend's full transition table (by design)

`backend/src/agents/lifecycle-state-machine.ts`'s own
`AGENT_LIFECYCLE_TRANSITIONS` additionally allows `connecting->active` and
`connecting->decommissioned`. The frontend's
`src/lib/agent-lifecycle-state-machine.ts` deliberately does NOT expose
those as user-triggered action-menu items, because:

- `connecting->active` happens automatically once
  `ConnectionValidationService`'s background validation succeeds (WO-080) —
  there is no "manually activate" button.
- There is no admin-facing "force-decommission a still-connecting agent"
  action in this WO's own acceptance criteria (AC 2: "Connecting and
  Decommissioned show no lifecycle actions").

The four exposed actions (pause/resume/retire/decommission) are each a
single named edge a human explicitly triggers; every one of them is still a
proper subset of the backend's own valid-transition table, so a 409 is the
safety net if the two ever drift, never a silent client/server mismatch.

## Files touched

**New:**
- `frontend/src/lib/agent-lifecycle-state-machine.ts` (+ test) — `getValidActions`, `isValidTransition`, `getCommonValidActions`, `requiresInFlightWarning`.
- `frontend/src/components/agents/agent-action-menu.tsx` (+ test) — per-row kebab/dropdown menu.
- `frontend/src/components/agents/lifecycle-confirmation-dialog.tsx` (+ test) — individual transition confirm dialog (shadcn AlertDialog).
- `frontend/src/components/agents/bulk-confirmation-dialog.tsx` (+ test) — bulk transition confirm dialog (AC 7).
- `frontend/src/components/agents/bulk-results-dialog.tsx` (+ test) — per-agent bulk results (FocusTrap-based, not AlertDialog — see design note below).
- `frontend/src/components/ui/alert-dialog.tsx` — new shadcn/ui primitive wrapping `@radix-ui/react-alert-dialog` (new dependency, `^1.1.23`, matching the existing `@radix-ui/react-dialog` version).
- `frontend/src/hooks/useLifecycleTransitionMutation.ts` (+ test) — PATCH mutation, 15s client timeout, 409/403 typed errors.
- `frontend/src/hooks/useBulkLifecycleMutation.ts` (+ test) — POST mutation, 35s client timeout (server budget is 30s).
- `frontend/src/app/agents/registry/page.lifecycle.test.tsx` — MSW integration tests: individual pause flow, individual resume flow, 409 conflict + refetch, bulk retire with partial failure, Connecting/Decommissioned have no menu.
- `frontend/src/app/agents/registry/lifecycle-a11y.test.tsx` — axe-core WCAG 2.1 AA scans of the action menu (open), both confirmation dialogs, the bulk toolbar (both normal and "no common actions" states), and the results dialog.
- 8 new fixtures under `frontend/src/test/fixtures/agents/` — one agent per lifecycle state, and success/partial-failure/full-failure/conflict/forbidden API response fixtures.

**Modified:**
- `frontend/src/app/agents/registry/page.tsx` — wires the mutations, transitioning-row state, confirmation dialogs, bulk results dialog, error banner.
- `frontend/src/app/agents/registry/page.test.tsx` — wrapped every `render()` in a `QueryClientProvider` (the page's two new mutation hooks call `useQueryClient`/`useMutation`, which throw without one). No assertions changed.
- `frontend/src/components/agents/agent-registry-table.tsx` (+ test) — Actions column now renders `AgentActionMenu` when `onSelectAction` is passed; new `transitioningIds` prop for the per-row spinner.
- `frontend/src/components/agents/agent-registry-bulk-toolbar.tsx` (+ test, fully rewritten) — replaces WO-079's disabled placeholder Pause/Retire buttons with all four actions, enabled/disabled per `getCommonValidActions`, plus the "no common actions" message (edge case).
- `frontend/src/components/ui/button.tsx` — exported `buttonVariants` (needed by `alert-dialog.tsx` to style `AlertDialogAction`/`AlertDialogCancel` consistently with `Button`).
- `frontend/src/types/dashboard.ts` — added `LifecycleTransitionResponse`, `BulkLifecycleAgentResult`, `BulkLifecycleResponse`.
- `frontend/package.json` / `package-lock.json` — added `@radix-ui/react-alert-dialog`.

## Design choice: AlertDialog for confirm dialogs, FocusTrap for the results dialog

Per the WO's own prompt for judgment here: `LifecycleConfirmationDialog` and
`BulkConfirmationDialog` are single confirm/cancel choices — exactly the
shape shadcn/ui's AlertDialog exists for, so both are built on the new
`ui/alert-dialog.tsx` (Radix `AlertDialog` primitive), getting
Escape-to-dismiss, focus trapping, and focus restoration for free.
`BulkResultsDialog` is a scrollable list with a Close (and optional Retry)
button, closer to a plain modal than a single yes/no choice, so it's built
on the codebase's own general-purpose `FocusTrap` (`components/a11y/focus-trap.tsx`)
the same way `MobileDrawer` uses Radix `Dialog` directly rather than
AlertDialog. Escape-to-close is wired via a `document`-level `keydown`
listener (not an `onKeyDown` on the overlay `<div>`) to satisfy
`jsx-a11y/no-static-element-interactions`.

## Acceptance criteria — verification

1. Context-sensitive per-row action menu — PASS. `AgentActionMenu` +
   `getValidActions`; `agent-action-menu.test.tsx`.
2. Active shows Pause/Retire, Paused shows Resume/Retire, Retired shows
   Decommission, Connecting/Decommissioned show none — PASS.
   `agent-lifecycle-state-machine.test.ts` (all 5 states),
   `agent-action-menu.test.tsx`.
3. Confirmation dialog with action/agent/current/target status, in-flight
   warning for Active — PASS. `lifecycle-confirmation-dialog.test.tsx`.
4. Exact in-flight warning copy — PASS, uses the exact AC string verbatim
   (`IN_FLIGHT_WARNING_MESSAGE`).
5. PATCH call + table update within 10s + row spinner — PASS.
   `useLifecycleTransitionMutation` invalidates the registry query on
   success; `transitioningIds` drives the spinner;
   `page.lifecycle.test.tsx`'s pause/resume flows exercise it end-to-end.
6. Bulk toolbar, intersection of valid actions — PASS.
   `getCommonValidActions`; `agent-registry-bulk-toolbar.test.tsx`.
7. Bulk confirmation dialog: count, list, warnings — PASS.
   `bulk-confirmation-dialog.test.tsx`.
8. Bulk POST + results summary — PASS.
   `useBulkLifecycleMutation.test.tsx`, `page.lifecycle.test.tsx`'s bulk
   retire w/ partial-failure test.
9. Real-time /ws/health reflects new status — PASS (pre-existing
   `useAgentHealthSocket`/merge logic from WO-079, reused unchanged; this
   WO's own mutation success additionally invalidates the REST query as a
   second, independent confirmation path).
10. Audit log entry per transition — PASS, pre-existing
    (`LifecycleService.transition`'s own `auditService.recordEvent` call);
    unchanged by this WO.
11. axe-core zero critical/serious on menu/dialog/toolbar/results-dialog —
    PASS. `lifecycle-a11y.test.tsx`, 6 scans.
12. Unit tests: state machine, confirmation dialog, bulk toolbar
    computation — PASS, see files above.
13. Integration tests: individual PATCH, bulk POST w/ mixed results,
    WebSocket status update — PASS. `page.lifecycle.test.tsx` (PATCH/POST
    via MSW); WS update path is the pre-existing, already-tested
    `useAgentHealthSocket` merge (WO-079's own `page.test.tsx` already
    covers "merges a real-time WebSocket status update into the displayed
    row" and continues to pass unmodified).
14. Mock fixtures for every lifecycle state + every API response scenario —
    PASS, 8 new fixture files under `test/fixtures/agents/`.

## Edge cases — verification

- Incompatible bulk selection -> "No common actions available for selected
  agents" message, all 4 buttons disabled — PASS,
  `agent-registry-bulk-toolbar.test.tsx`.
- 409 race condition -> inline "Agent status has changed..." + registry
  refetch — PASS, `page.lifecycle.test.tsx`.
- Bulk partial failure -> results dialog distinguishes success/failure per
  agent — PASS.
- Network failure / 15s client timeout — PASS,
  `LIFECYCLE_TRANSITION_TIMEOUT_MS` aborts and surfaces a
  `LifecycleTransitionError`; not separately integration-tested (would
  require faking `AbortController` timers), documented as a known trim.
- Rapid double-click / debounced confirm — PASS, both confirmation dialogs
  disable Confirm and `preventDefault()` a second click while
  `isPending`; covered by `lifecycle-confirmation-dialog.test.tsx`'s
  "does not call onConfirm a second time when pending" test.
- Decommissioned agents stay visible, no actions — PASS (already true via
  `getValidActions("decommissioned") === []`); a "Hide Decommissioned"
  filter toggle is explicitly called out in the AC only as "consider" —
  not implemented, honest trim (out of this WO's own acceptance criteria
  list, which never requires it).

## Honest scope trims

- No dedicated test for the 15s client-side abort timer firing (would need
  fake timers around `AbortController`, which MSW's own request matching
  interacts awkwardly with); the implementation and its 403/409/generic
  error paths are otherwise fully tested.
- "Hide Decommissioned" filter toggle (edge_cases, phrased as "consider")
  not built — not in the numbered acceptance criteria.

## Verification commands run

- `npx tsc --noEmit` (frontend) — clean.
- `npx eslint .` (frontend, full repo) — 0 errors (1 pre-existing warning,
  `useVirtualizedAgentList.ts`, unrelated).
- `npx vitest run` (frontend, full suite) — **79 files / 473 tests, all
  passing** (up from the pre-WO-081 baseline; every new/modified file
  covered).
- `npm run build` (frontend, `next build`) — succeeds, all 8 static routes
  generated including `/agents/registry`.
- `gitleaks detect --source frontend/src --no-git -v` — 1 finding, the
  pre-existing accepted `recharts dataKey` false positive
  (`health-history-chart.tsx`), no new findings.
- `gitleaks detect --source backend --no-git -v` — 7 findings, all
  pre-existing accepted backend test fixtures, no new findings (backend
  untouched).
- `semgrep --config .semgrep.yml frontend/src` — 0 findings.
- `npm audit --omit=dev` (frontend) — 0 vulnerabilities.
- Backend: no changes made; not re-run (WO-032/033's own suites already
  cover everything this UI calls, and `git status` on `backend/` is clean).

## Not done (per scope boundary)

No `git commit` beyond what's on this branch was requested to be withheld —
changes are committed locally on `feat/wo-081-lifecycle-management-ui`. No
push, no PR, no Forge transition/update/complete calls were made.
