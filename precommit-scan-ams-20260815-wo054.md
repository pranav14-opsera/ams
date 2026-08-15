# Pre-commit security scan — WO-054 (WebSocket real-time hooks)

**Date:** 2026-08-15
**Branch:** wo-054-websocket-hooks

## Scope
`useWebSocket`, `useWebSocketBatcher`, `useRealtimeUpdates`, `realtime-store`, `connection-status-indicator`, WS protocol types/fixtures/mock server, and an `app-store` auth-token field addition.

## Scans
- `gitleaks detect` (after `rm -rf .next`): clean, no secrets.
- Custom `.semgrep.yml` ruleset: clean.
- `npm audit` (frontend): no new advisories introduced by this WO's deps (no new deps added).

## Notes
- WebSocket auth token flows from `app-store` auth state into a `ws://.../?token=` style connect message payload only — never logged, never persisted beyond the existing store.
- Mock WebSocket server and fixtures are test-only, under `src/test/**`, excluded from production build output.

## Bugs found & fixed during implementation
- Unsubscribe-on-unmount was silently dropped due to cross-hook effect cleanup ordering; fixed via a new `onBeforeClose` hook option (see `useWebSocket.ts`/`useRealtimeUpdates.ts`).
- Two test-flakiness fixes (act()-wrapping around timer advances; stress-test trailing flush).

## Result: PASS
