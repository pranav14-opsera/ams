# TimescaleDB Schema — Substitute Architecture (WO-042)

## Why this WO's literal request isn't implemented as written

WO-042 asks for TimescaleDB hypertables, continuous aggregates, compression
policies, and retention policies. TimescaleDB is not available to this
platform:

- **Production target**: AWS RDS for PostgreSQL (and Aurora PostgreSQL) do
  not support the TimescaleDB extension — a documented AWS platform
  limitation, established and cited in migration 007 (`agent_metrics`'s
  original creation, predating this WO).
- **This sandbox**: confirmed directly —
  `SELECT * FROM pg_available_extensions WHERE name = 'timescaledb'` returns
  zero rows against this environment's local Postgres. TimescaleDB SQL
  syntax (`create_hypertable`, `CREATE MATERIALIZED VIEW ... WITH
  (timescaledb.continuous)`, `add_compression_policy`, `add_retention_policy`)
  would fail outright here, not just in the RDS production target.

Migration 007 already committed this platform to a substitute architecture
for the *first* granularity (5-minute buckets). This WO's actual
requirements — multiple aggregate granularities, tenant-scoped retention,
composite indexing, RLS enforcement — are implemented as an **extension of
that same substitute**, not a re-litigation of it.

## What's implemented instead (migration 036)

| TimescaleDB concept | Substitute |
| --- | --- |
| Hypertable + 1-day chunks | Migration 007's native `PARTITION BY RANGE (recorded_at)` on `agent_metrics`, hourly chunks via `create_agent_metrics_partitions()` |
| Space partitioning by `tenant_id` | Composite index `(tenant_id, agent_id, recorded_at)` (migration 007) — sufficient for this table's query patterns; native declarative partitioning doesn't support a second partition dimension without sub-partitioning, which isn't warranted at this data volume |
| Continuous aggregates (5s / 15s / 60s) | Three additional materialized views — `agent_health_5s_agg`, `agent_credits_15s_agg`, `agent_analytics_60s_agg` — computed with `percentile_cont`/`FILTER`, the same shape as migration 007's `agent_metrics_5min_agg` |
| Refresh policies | Manual `REFRESH MATERIALIZED VIEW [CONCURRENTLY]` (a scheduled job — pg_cron or an external scheduler — must call this on the 5s/15s/30s cadence the AC asks for; not implemented as an actual cron entry in this migration, matching migration 007's own precedent of leaving scheduling external) |
| Retention policies | `drop_expired_agent_metrics_partitions(retention_days)` — drops entire hourly partitions past the cutoff. Dropping a raw-data partition also implicitly ages it out of every aggregate view's next refresh, so no separate aggregate-retention step is needed |
| Compression policies | **Not implemented.** Genuine columnar/TimescaleDB compression requires the extension. Achieving this platform's own "≥5x compression" target without it would mean rolling custom columnar storage or an external cold-storage export — a platform-level infrastructure decision, out of scope for a database migration |
| RLS on aggregates | Postgres RLS policies don't apply to materialized views. Every new view gets a `_scoped` wrapper view (matching migration 007's `agent_metrics_5min_agg_scoped`) that re-applies `tenant_id = current_setting('app.current_tenant', true)::uuid` |

## Metric coverage

`agent_metrics.metric_name`'s CHECK constraint is extended (migration 036)
to add `token_consumption` and `tool_call_success` (recorded as 1/0) so the
new aggregate views can compute total token consumption and average
tool-call success rate, per this WO's AC. `MetricsAggregatorService`
(WO-041) now records these two additional metrics per canonical telemetry
event, alongside the pre-existing `latency_ms`/`error_rate`.

The pre-existing `agent_metrics_5min_agg` view (migration 007) is dropped
and recreated with the same two additional columns, so all four
granularities expose an identical aggregate shape.

## If genuine TimescaleDB is required later

That's a platform-level decision to run `agent_metrics` on separate,
self-managed infrastructure (a dedicated EC2/container Postgres instance or
Timescale Cloud) rather than RDS — out of scope for this migration, same
conclusion migration 007 already reached.
