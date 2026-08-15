# Pre-commit security scan — WO-060 (Multi-Channel Alert Delivery Service)

**Date:** 2026-08-16
**Branch:** wo-060-alert-delivery-service

## Scope
Migration 047: `webhook_configs` (BYOK-encrypted HMAC secret, same pattern as `agents.connection_config`), `email_channel_configs`, `alert_delivery_log` (immutable) tables. Three real channel implementations (`WebSocketAlertChannelService`, `WebhookAlertChannelService`, `EmailAlertChannelService`) behind a shared `AlertChannel<TConfig>` interface. `AlertDeliveryService` (idempotency check, parallel dispatch via `Promise.allSettled`, per-attempt delivery-log + audit logging, 60s-TTL Redis-cached resolved channel configs). `AlertChannelConfigService`/`Controller` (CRUD, secret masking, `/test` connectivity endpoint). `ThresholdEvaluatorService` (WO-059) now hands each generated alert to `AlertDeliveryService` instead of publishing to the WS channel directly itself.

## Scans
- `gitleaks detect`: clean — one pre-existing false positive already documented in WO-057/058/059's own scans (`dataKey="latencyP50Ms"`, unrelated). No new secrets flagged, including this WO's own test fixture "secrets" (deliberately fixture data, never real).
- Custom `.semgrep.yml` ruleset (raw-sql-missing-tenant-filter): 0 findings — every new repository (`webhook-config.repository.ts`, `email-channel-config.repository.ts`, `alert-delivery-log.repository.ts`) explicitly filters by `tenant_id`.
- `npm audit` (backend, production deps, including the new `handlebars`/`@aws-sdk/client-sesv2` dependencies): 0 vulnerabilities.

## Design notes / honest scope substitutions
- **Kafka consumer (implementation step 9)**: this sandbox has no reachable Kafka broker (same documented gap as WO-041/043/046/055/059 throughout this codebase) — `ThresholdEvaluatorService` calls `AlertDeliveryService.deliver()` directly, in-process, immediately after each breach. The delivery logic itself (resolve configs, dispatch in parallel, log, audit, idempotency-check) is genuine and fully tested; only the transport hop from "event produced" to "delivery triggered" is a direct call instead of a consumer group.
- **Webhook delivery is genuinely, fully tested end-to-end**: a real local HTTP server (Node's own `http` module, ephemeral port) receives real HMAC-SHA256-signed POST requests and the test independently recomputes/verifies the signature — no external dependency needed for this channel, unlike email/Kafka.
- **Email delivery**: `EmailProviderPort` behind an `EMAIL_ADAPTER` environment switch (`mock` default / `ses` real), same pattern as `encryption.module.ts`'s `KMS_ADAPTER`. The real `SesEmailProviderService` genuinely calls AWS SESv2's SDK — this sandbox has no reachable AWS account/credentials (same connector-gap class as WO-015's KMS adapter), so it will fail at runtime without real credentials, exactly as expected; the request construction and port contract are real and tested via the in-memory double.
- **Channel-config Redis cache security tradeoff, stated explicitly**: caching the *decrypted* webhook secret in Redis for up to 60s (to avoid a KMS decrypt call on every single delivery) means the plaintext secret has a bounded residency window in a private, same-VPC Redis instance — the same trust boundary every other Redis-cached value in this codebase already sits inside. Documented directly in `channel-config-cache.service.ts` rather than silently accepted.
- **In-app WS role targeting**: `team_lead` is scoped tenant-wide (not to their own team's agents specifically) since no per-team WebSocket channel splitting exists in this codebase — same documented simplification as WO-057's own team-scoping precedent when a finer mechanism doesn't exist.

## Result: PASS
