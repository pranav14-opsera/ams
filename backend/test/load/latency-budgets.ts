/**
 * WO-044's own segment budgets, as literally specified in the AC. Each
 * budget is a P99 ceiling in milliseconds.
 *
 * Mapping from the AC's conceptual segments to what THIS sandbox can
 * genuinely measure (no reachable Kafka broker — see LOAD_TEST_RESULTS.md):
 *   - "agent emit -> Kafka publish"        -> stage "kafka_publish_attempt"
 *     (the real kafkajs produce call itself; here it fails fast against
 *      an unreachable broker rather than round-tripping to a real one —
 *      NOT a substitute for real network latency, see the doc).
 *   - "Kafka -> stream processing"          -> NOT VERIFIABLE in this
 *     environment (no broker, no consumer group exists at all).
 *   - "stream processing -> TimescaleDB write" -> stage "postgres_metrics_write"
 *     (the real MetricsAggregatorService write against real Postgres).
 *   - "TimescaleDB -> WebSocket push"        -> stage "websocket_delivery"
 *     (measured separately, via the real Redis pub/sub -> gateway ->
 *      client hop, in ws-load-test-integration.test.ts).
 *   - "WebSocket -> dashboard render"        -> NOT VERIFIABLE (no
 *     frontend client exists in this repo).
 */
export const LATENCY_BUDGETS_P99_MS: Record<string, number> = {
  kafka_publish_attempt: 2000,
  postgres_metrics_write: 2000,
  websocket_delivery: 5000,
};

export const CI_REGRESSION_TOLERANCE = 1.2; // AC: "P99 latency budget by more than 20%"
