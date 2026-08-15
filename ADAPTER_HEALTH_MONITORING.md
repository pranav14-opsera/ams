# Adapter Version Compatibility Matrix & Health Monitoring (WO-039)

## Endpoints

- `GET /api/v1/adapters/compatibility` — every registered adapter's type, adapter version, supported framework version range (node-semver syntax), and current health status.
- `GET /api/v1/adapters/{type}/health` — current status, last check timestamp, consecutive failure count, and the last 10 health check records.

Both are RBAC-gated behind `agent_management:agent:read` (the same permission agent read endpoints already use) — this is observability data about the platform's own adapters, not a new authorization concern.

## Health monitoring

`AdapterHealthSchedulerService` ticks every 10 seconds, checks which adapters are due for a probe (`now >= last_health_check_at + health_check_interval_seconds`, default 60s), and fires `AdapterHealthService.runHealthProbe()` for each due adapter with a random 0–5s jitter delay (avoids every adapter probing at the exact same instant).

Each probe calls the adapter's own `getHealthProbe()` (`IAgentAdapter`, WO-034) and records a row in `adapter_health_checks` (`healthy`/`unhealthy`, response time, error details). `adapter_configurations.consecutive_failures` increments on failure and resets to 0 on success; **3 consecutive failures** flips `health_status` to `degraded` (a successful probe at any point flips it straight back to `healthy`).

### No dedicated alerting connector

This WO's acceptance criteria call for "an alert event... published to the Alert Service" — no PagerDuty/Slack/email connector exists in this codebase (same connector-gap pattern as WO-008's Snyk/SonarQube, WO-012's live EKS cluster, WO-015's AWS KMS). The durable, queryable record of a degraded transition **is** `adapter_configurations.health_status` itself (immediately visible via `GET /api/v1/adapters/{type}/health`); `AdapterHealthService` additionally emits a structured `Logger.error("ALERT: ...")` line a real on-call/log-aggregation pipeline (Datadog, CloudWatch alarms, etc.) can page on today.

## Version compatibility

`AdapterHealthService.checkVersionCompatibility(adapterType, frameworkVersion)` matches the reported version against `adapter_configurations.supported_framework_versions` via the `semver` package. This is advisory only — passing `frameworkVersion` in `POST /api/v1/agents` never blocks registration, even when the version falls outside the supported range; the response's `compatibilityWarning` field surfaces `{compatible, supportedRange, reason?}` instead.

## Seeded configuration

Migration 035 seeds all 4 documented adapters:

| adapter_type | supported_framework_versions |
|---|---|
| `langchain` | `>=0.2.0 <0.4.0` |
| `crewai` | `>=0.30.0 <0.60.0` |
| `autogen` | `>=0.2.0 <0.5.0` |
| `generic_rest` | `*` (no framework version concept — REST is the universal fallback) |
