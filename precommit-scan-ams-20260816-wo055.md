# Pre-commit security scan — WO-055 (WebSocket Subscription Manager, tenant-scoped filtering)

**Date:** 2026-08-16
**Branch:** wo-055-subscription-manager

## Scope
`SubscriptionRegistryService`, `ChannelPermissionsService`, `SubscriptionManagerService`, `HeartbeatManagerService`, `KafkaConsumerBridgeService` (backend, under `websocket-gateway/subscription/`), plus fixtures and tests.

## Scans
- `gitleaks detect` (after `rm -rf frontend/.next`): clean, no secrets. (Initial scan flagged a github-pat-shaped string inside the gitignored `.next/` turbopack build cache — confirmed not present in any tracked source file, the known build-cache false-positive gotcha, resolved by removing the cache.)
- Custom `.semgrep.yml` ruleset: clean, 0 findings.
- `npm audit` (backend, production deps): 0 vulnerabilities.

## Security-critical design notes
- **Tenant isolation, defense in depth**: enforced at subscribe-time (requested tenant must equal the session's own JWT-derived tenant, or the attempt is rejected and logged as a security event) AND at fan-out-time (a runtime assertion double-checks every recipient's tenantId before `send`, even though `SubscriptionRegistryService.getUsersByTenantAndChannel` should already guarantee it structurally).
- **PHI-adjacent channel** (`phi-access`) requires `audit_access:phi_monitoring:view`, matching the same permission the REST audit endpoints already gate on (`rbac.constants.ts`) — not a new, separately-invented permission.
- Cross-tenant subscription attempts and permission denials are logged via the existing `"security event:"` Logger convention (matches `tenant-context.middleware.ts` / `base-realtime.gateway.ts`).
- Kafka consumer is an in-process `process(event)` bridge, following this codebase's established documented substitution for "no reachable Kafka broker in this sandbox" (same pattern as `AuditEventConsumerPipelineService`, `MetricsAggregatorService`, `TelemetryPipelineService`).

## Result: PASS
