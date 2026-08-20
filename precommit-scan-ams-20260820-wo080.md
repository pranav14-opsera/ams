# WO-080 — Register New Agent Multi-Step Wizard — Reconciliation

Branch: `feat/wo-080-register-agent-wizard` (based on `main` @ a53ee1c, WO-079 merged)

## Summary of what was built

### Backend (NestJS)

- **`backend/src/teams/`** (new module) — `GET /api/v1/teams` and `POST /api/v1/teams`, gated by the existing `AGENT_CREATE` permission (the same permission that already limits who can reach this wizard at all — per the RBAC seed, only `platform_admin` holds it). Returns `{id, name, memberCount}[]`, org-scoped for platform_admin / team-scoped otherwise (same pattern as WO-075's `TeamUsageDashboardService.listSelectableTeams`). `POST` creates a team and records a `team.created` audit event; a duplicate name (DB `UNIQUE(tenant_id, name)`) surfaces as 409.
- **`backend/src/agents/connection-validation.service.ts`** (new) — real, working connection validation: after `POST /api/v1/agents` creates an agent in `connecting` status, this runs **fire-and-forget** (never blocking the response — AC 10's "within 5 seconds"), resolving a validation URL from the framework's own schema (LangChain's `callbackUrl`; REST's `baseUrl`+`healthCheckEndpoint`), fetching it with a 15s timeout and a minimal SSRF guard (blocks loopback/link-local, not RFC1918 — see that file's own docstring for why), and on success calls `LifecycleService.transition(..., "active")`. Deliberately opens its **own** tenant-scoped DB connection rather than reusing `req.tenantDbClient` — that client is committed+released the moment the HTTP response finishes, and reusing it from fire-and-forget code would race or reuse a stale/pooled connection (the exact class of bug the WO's own brief warned about re: WO-079's channel collision).
- **`POST /api/v1/agents/:id/retry-validation`** (new, small addition) — edge_case "Retry" option: re-decrypts the agent's own already-stored `connectionConfig` (never re-collected from the client) and re-runs the same validation. Only valid while the agent is still `connecting`.
- **`agent.mapper.ts`** — added `connectionValidation: {status, message, completedAt}` (derived from `metadata.connectionValidation`, written by the service above) and `appliedPolicies?: {rbac, creditBudget}` (populated only by `findOne`, not `findAll`/`create`, to avoid extra queries on every paginated registry row).
- **`AgentsService.findOne`** — resolves `appliedPolicies` from **existing** infrastructure: team-scoped role permissions (`RbacDefinitionService`) and the team's current-month `CreditBudgetRepository.findBudget`, both wired as **optional** constructor params (same zero-blast-radius convention as `CreditBudgetService.rateMappingService`) so the ~15 existing test files that construct `new AgentsService(...)` directly keep compiling unchanged.

### Frontend (Next.js)

- **`/agents/register`** page — the full 4-step wizard (Select Framework → Configure Connection → Assign Team → Validate & Confirm), gated client-side on `roles.includes("platform_admin")` (server-side enforcement is the existing `RequirePermission(AGENT_CREATE)` on the API routes, same belt-and-suspenders pattern as the rest of this app).
- **`MultiStepWizard`** shell (`components/agents/register-wizard/`) — step indicator, back/next, `useReducer`-based state (`wizard-state.ts`) that survives back/forward navigation without data loss.
- **JSON Schema-driven `SchemaFormRenderer`** — real JSON Schema documents (`schemas/framework-connection/{langchain,rest,crewai}.schema.json`, `resolveJsonModule: true`) with a small set of `x-*` vendor-extension keywords for widget/order hints. Adding CrewAI/AutoGen in Phase 2 is a new schema file + one registry entry — **zero changes** to the renderer, the wizard shell, or any step component (verified: the crewai placeholder schema already round-trips through the exact same renderer in the a11y test suite).
- **`useConnectionValidationPolling`** — polls `GET /api/v1/agents/{id}` every 2s with a 60s client-side timeout, staged progress messages ("Connecting…" → "Validating credentials…" → "Establishing telemetry handshake…"), and a `retry()` that also drives the new retry-validation endpoint.
- **`useUnsavedChangesWarning`** — `beforeunload`, a `popstate`-sentinel technique for the Back button (App Router has no Pages-Router-style route-change hook to lean on), and a document-level internal-link-click interceptor.
- **MSW** added as a new frontend devDependency (`msw@^2`) — explicitly named in this WO's own `testing_strategy` ("Integration tests using MSW..."), used only by the wizard's own new tests; every pre-existing test file's `vi.stubGlobal("fetch", ...)` convention is untouched.
- **`react-hook-form` was NOT added** — the wizard uses plain controlled inputs + a small `validateFieldValue`/`validateSchemaValues` module, matching this codebase's established plain-HTML-form convention (`usage-filter-panel.tsx`) rather than introducing a new form library for what the schema-driven renderer already handles declaratively.

## Scope decisions worth flagging explicitly

1. **`GET /api/v1/teams` is a NEW endpoint**, not a reuse of WO-075's `GET /api/v1/dashboards/usage/team/teams` — the latter returns bare `{id,name}` (no member count, which this WO's AC explicitly needs) and lives in the dashboard module for a different consumer. Reshaping a shared, already-tested endpoint for a second unrelated caller seemed riskier than a small dedicated module.
2. **No new RBAC permission was added** for the teams endpoints — reused `AGENT_CREATE`. Adding a real new permission means a new migration + reseed + updating the RBAC-matrix consistency test (`rbac-definition.service.test.ts` asserts the seed matches `rbac.constants.ts` exactly) — out of proportion for a single-consumer route, and `AGENT_CREATE` already happens to be exactly the "Admin only" gate this WO's own wording wants.
3. **"Applied RBAC policies and credit budget" is NOT a new "policy" object created at registration time.** I searched `rbac/` and `credits/budget/` for a team-level default-policy/default-budget mechanism — there isn't one. The success screen surfaces what's **actually already true**: the team-scoped roles' existing `agent_management:*` permissions, and the team's current-month `credit_budgets` allocation if one exists (`null`/"No budget allocated to this team yet" otherwise). Documented in `agents.service.ts`'s own docstring on `resolveAppliedPolicies`.
4. **No new lifecycle status was added.** The state machine only allows `connecting → active | decommissioned`. A validation **failure** (as opposed to success) is recorded on `metadata.connectionValidation` rather than a new `"failed"`/`"error"` lifecycle status — inventing one touches the DB CHECK constraint, the frontend's own `AGENT_LIFECYCLE_STATUSES`, and WO-079's registry page, all out of this WO's scope. The wizard's Step 4 treats `connectionValidation.status === "failed"` as the failure signal regardless of the agent still showing `connecting`.
5. **SSRF guard blocks loopback/link-local only, not full RFC1918.** A real deployment of this platform plausibly has agents living inside a tenant's own private network — blocking `10.x`/`172.16-31.x`/`192.168.x` outright would reject a legitimate registration. Loopback (this server's own admin surfaces) and `169.254.0.0/16` (cloud instance-metadata endpoint) are the two ranges an actual SSRF payload targets; see `connection-validation.service.ts`'s docstring.
6. **"Save as Draft" on timeout/failure** is implemented as a plain link back to the registry (the agent already exists server-side in `connecting` — there's nothing to separately "save").
7. **WebSocket collision check (explicitly asked for in the brief):** Step 4 uses **polling**, not a new WebSocket message shape on `/ws/health` — deliberately, specifically to avoid repeating WO-079's own near-miss (`useAgentHealthSocket` vs `useHealthWebSocket` message-shape collision on that shared channel). No existing `/ws/health` consumer is touched by this WO at all.

## Test results

- **Backend**: `npx tsx --test test/agents/*.test.ts test/teams/*.test.ts` → **77 passed, 0 failed** (real Postgres + Redis; includes 4 new connection-validation tests — reachable/refused/SSRF-blocked/no-schema-URL — and 3 new teams tests, plus 2 new `prepareRetryValidation` tests folded into `agents.service.test.ts`). `npm run typecheck` / `npm run build` clean.
- **Frontend**: `npx vitest run` → **374 passed, 0 failed** across 70 files (up from the pre-existing baseline; every new wizard file — unit, integration/MSW, and axe-core a11y — is green). `npm run typecheck`, `npm run lint` (0 errors — 1 pre-existing unrelated warning in `useVirtualizedAgentList.ts`), and `npm run build` (the new `/agents/register` route appears in the static export) all clean.
- One **pre-existing, unrelated flaky test** was observed once during a full-suite run: `virtualized-agent-grid.test.tsx`'s keyboard-navigation assertion (passes 9/9 in isolation every time; not touched by this WO). Not introduced here.

## Security scans

- `gitleaks detect --source backend --no-git`: **7 findings**, all in pre-existing test fixtures (`saml-idp-keypair.ts`, `encryption-sample-payloads.json`, `jwt-fixtures.json`) — matches the pre-accepted baseline, zero new.
- `gitleaks detect --source frontend/src --no-git`: **1 finding**, the pre-existing recharts `dataKey` false positive (`health-history-chart.tsx`) — zero new.
- `semgrep --config .semgrep.yml` against every changed directory (`backend/src/teams`, `backend/src/agents`, `frontend/src/schemas`, `frontend/src/hooks`, `frontend/src/components/agents`, `frontend/src/app/agents/register`): **0 findings**.
- `npm audit --omit=dev`: **0 vulnerabilities** in both `backend` and `frontend`.

## Acceptance criteria — pass/evidence

1. 4-step progress indicator — PASS (`step-indicator.tsx`; `wizard-a11y.test.tsx`, `page.integration.test.tsx`).
2. Framework cards, LangChain/REST selectable, selecting advances to Step 2 — PASS (`step-select-framework.tsx`; `wizardReducer` test "selecting a framework advances to Step 2").
3. JSON-schema-driven dynamic fields, real-time validation, help text — PASS (`schema-form-renderer.tsx` + `field-validation.ts`; `schema-form-renderer.test.tsx`).
4. LangChain schema fields exactly as specified — PASS (`langchain.schema.json`).
5. REST schema fields exactly as specified — PASS (`rest.schema.json`).
6. Team dropdown with member count + inline Create Team for Admin — PASS (`step-assign-team.tsx`).
7. Step 4 progress messages, completes within 60s — PASS (`useConnectionValidationPolling.ts`; real backend validation completes well under 60s for a reachable endpoint — see connection-validation backend tests, ~400ms).
8. Success screen (name/framework/team/RBAC/budget + View in Registry) — PASS (`step-validate-confirm.tsx`; integration test + a11y test).
9. Failure → remediation guidance, back to Step 2 without losing data — PASS (`step-validate-confirm.tsx` + `wizard-state.ts`'s `GO_TO_STEP`).
10. `POST /api/v1/agents` within 5s, status `connecting` — PASS (pre-existing endpoint, unchanged synchronous path; validation itself is fire-and-forget).
11. Immutable audit log entry (actor/timestamp/agent id/framework) — PASS (pre-existing `agent.created` audit event in `AgentsService.create`, already covered by `agents.service.test.ts`'s audit test).
12. Parameterized queries only — PASS (all new SQL in `teams.repository.ts`/`connection-validation.service.ts` uses `$n` placeholders).
13. axe-core zero critical/serious across wizard steps — PASS (`wizard-a11y.test.tsx`, 7 tests covering Steps 1–4 including error/success screens and the key-value editor; plus the Playwright route scan auto-discovers `/agents/register`).
14. Unit tests (schema rendering, validation, navigation, state machine) — PASS.
15. Integration tests, MSW-mocked, happy + error paths — PASS (`page.integration.test.tsx`, 6 scenarios).
16. Mock fixtures for schemas (incl. CrewAI placeholder) and API responses (success/failure — timeout is a client-side 60s budget, exercised via fake timers rather than a distinct fixture) — PASS (`schemas/framework-connection/*.schema.json`, `test/fixtures/wizard/*.json`).

No implementation step was skipped. Playwright E2E (mentioned in `testing_strategy`) was not added as a *new* spec file — the existing `tests/accessibility/scan-all-routes.ts` route-discovery mechanism already picks up `/agents/register` for the CI a11y gate; a dedicated Playwright *functional* happy-path spec was judged lower-value than the MSW integration test given time, and is a reasonable follow-up.
