# Pre-commit scan — WO-069 (Credit threshold alert notifications)

## Scope
`ThresholdMonitorService`: evaluates each team's budget consumption after
every reconciliation batch, generates at most one alert per (team,
threshold level, period) via `credit_alerts`, and delivers it by email
(Team Lead + Finance Manager), webhook (if configured), and in-app
(WebSocket).

## Architectural decisions
- **A genuinely separate delivery path from WO-060's `AlertDeliveryService`/
  `AlertEvent`, not a reuse of it.** `alert_events.agent_id` is a `NOT
  NULL` FK (migration 046) — every alert in that pipeline is agent-
  scoped, and its `EmailAlertChannelService` renders an agent/metric-
  breach template. A credit threshold breach is TEAM-scoped with no
  agent at all, and its own required content (team name, allocated/
  consumed/remaining credits, projected exhaustion date) is entirely
  different from that template. Reusing the pipeline as-is would mean
  either fabricating a fake agent reference (the same mismatch WO-067
  already found) or silently rendering the WRONG content into a real
  notification — so this WO reuses only the genuinely payload-agnostic
  pieces instead: `WebhookConfigRepository` (tenant-scoped, no agent
  concept at all) + `WebhookAlertChannelService.deliver()` (a pure
  JSON.stringify + HMAC-sign + POST that never touches `alert_events`),
  the same `EMAIL_PROVIDER` port WO-060's own email channel wraps (with
  a genuinely new, credit-specific HTML template), and `RedisPubSubService`
  directly for in-app delivery.
- **Recipient resolution reuses this schema's own real role model.**
  `users.role` (added by migration 023, JIT-provisioned from IdP group
  claims) is the only place a platform-wide role like `finance_manager`
  is actually queryable — there is no separate role-assignment table.
  "Team Lead" is a `team_members.role = 'lead'` attribute, distinct from
  a platform role entirely. Both are queried directly; no fabricated
  recipient list.
- **Event-driven via a direct, in-process call, not a real Kafka
  consumer.** Same documented environment gap as every Kafka-touching WO
  this session (no reachable broker) — `CreditReconciliationService`
  gained an optional `ThresholdMonitorService` constructor param (zero
  blast radius) and calls `evaluateThresholds` immediately after a
  batch's own refresh+re-warm step succeeds, grouping affected
  `(tenantId, teamId)` pairs by tenant first (one call per tenant, not
  once per event/team pair).
- **Both thresholds are evaluated independently per tick, not
  mutually exclusive.** A team crossing both 75% and 90% within the SAME
  batch genuinely receives TWO separate alerts (each with its own
  dedup row and its own email) — matching the AC's own wording ("a
  SEPARATE alert is generated" for 90%). Verified at every AC-specified
  boundary (74/75/76/89/90/91%).
- **Dedup is a real, atomic `ON CONFLICT DO NOTHING`** on
  `(tenant_id, team_id, threshold_level, effective_month, effective_year)`
  — `tryCreateAlert` returns `null` on a duplicate, which the service
  treats as "already alerted, do not re-deliver," never a fabricated
  success.

## Verification
- `npm run typecheck` / `npm run build` — clean.
- `node scripts/verify-boot.js` — full DI graph resolves.
- Unit tests: `threshold-monitor.service.test.ts` (10 — every AC boundary
  value, dedup across re-evaluation, a later-in-period second threshold
  crossing still fires, zero-allocation guard, no-budget-configured skip,
  per-team failure isolation, full payload field verification including
  urgency wording); 3 new tests added to
  `credit-reconciliation.service.test.ts` (the reconciliation-batch hook:
  grouped-by-tenant invocation, no-trigger-on-empty-batch, zero-blast-
  radius when unwired).
- Real Postgres+Redis integration tests
  (`threshold-monitor-integration.test.ts`, 2 tests): a team crossing 75%
  of a REAL allocated budget generates exactly one real, persisted
  `credit_alerts` row and a real email to its real team lead + finance
  manager (found via `users.role`/`team_members.role`), with genuine
  redelivery-safe deduplication (no second row, no second email on
  re-evaluation); a team jumping straight to 95% generates both real
  alerts with two distinct real emails.
- Full regression: `test/credits`, `test/tenants`, `test/rbac`,
  `test/alerts` — 221 passing, 0 failing — zero regressions from
  widening `AlertsModule`'s exports (`WebhookConfigRepository`,
  `WebhookAlertChannelService`, `EMAIL_PROVIDER`) or the new optional
  constructor param on `CreditReconciliationService`.
- Security: gitleaks (1 finding — the same already-documented recharts
  false positive), semgrep (0 findings), `npm audit` (0 vulnerabilities).
