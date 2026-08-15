# Pre-commit security scan — WO-058 (Dashboard Virtualization and Performance Optimization)

**Date:** 2026-08-16
**Branch:** wo-058-dashboard-virtualization

## Scope
Frontend: `@tanstack/react-virtual`-based `VirtualizedAgentGrid` + `useVirtualizedAgentList` hook, `AgentHealthCard` wrapped in `React.memo` with a custom field-level comparator, a Comlink-backed `healthMetricsWorker` (Web Worker) + `useHealthMetricsWorker` hook (graceful main-thread fallback), `useFleetHealthInfiniteQuery` (offset-based progressive pagination), a 600-agent performance fixture. Backend: two small, targeted fixes so the live fleet snapshot and REST pagination cap can actually cover this WO's own 500+-agent scaling target (`ListAgentHealthQueryDto.limit` max raised 200→1000; `HealthMetricsPublisherService` now queries with an explicit high limit instead of the DTO's 50-agent default).

## Scans
- `gitleaks detect`: clean — one pre-existing false positive already documented in WO-057's scan (`dataKey="latencyP50Ms"`, a recharts prop name, not a secret) re-appears, unchanged.
- Custom `.semgrep.yml` ruleset (raw-sql-missing-tenant-filter): 0 findings.
- `npm audit` (backend + frontend, production deps, including the new `@tanstack/react-virtual`/`comlink` dependencies): 0 vulnerabilities.

## Notes
- **Performance test honesty**: jsdom has no real paint/compositor pipeline, so there is no genuine frame rate to measure in a Vitest unit test. `virtualized-agent-grid.performance.test.tsx` measures a documented PROXY (bounded render time across simulated rapid updates, and — the actual real guarantee — a bounded DOM node count regardless of a 600-agent input) rather than fabricating an "fps" number. The AC's literal "Chrome DevTools Performance profiling" wording would need a real-browser measurement this repo's Playwright suite doesn't yet include; flagged rather than silently claimed as covered.
- **WebSocket batching AC**: already satisfied by WO-054's existing `useWebSocketBatcher`/`useRealtimeUpdates` infrastructure (100ms rAF-batched flush, single state update per batch) — not reimplemented via a new `useReducer`, since the mechanism this WO's AC describes already exists and already applies to the `useHealthWebSocket` channel.
- Fixed one pre-existing, unrelated flaky test found while running the full suite (`useWebSocket.test.ts`'s exponential-backoff timing test) — a too-tight ~1000ms boundary assertion, same class of timing fragility already documented and fixed once before (WO-054's `live-region-announcer` debounce test) under coverage-instrumentation load. Widened the margin; no behavior change.

## Result: PASS
