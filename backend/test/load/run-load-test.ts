import type { TelemetryPipelineService } from "../../src/adapters/pipeline/telemetry-pipeline.service";
import { LatencyCollector } from "./latency-stats";
import type { LoadTestReport } from "./latency-report";
import { generateSyntheticEvent, type SyntheticEventGeneratorConfig, type SyntheticTenantAgent } from "./synthetic-event-generator";

export interface LoadTestProfile extends SyntheticEventGeneratorConfig {
  name: string;
}

export interface RunLoadTestOptions {
  /**
   * Overrides profile.durationSeconds — the committed profile JSON files
   * hold the AC's literal 1800s/300s durations (documentation of the
   * real target), but an automated test run needs a much shorter slice
   * while still honoring the profile's eventsPerSecond rate. See
   * LOAD_TEST_RESULTS.md for full-duration results from a real run.
   */
  durationSecondsOverride?: number;
}

/**
 * Drives synthetic events through the REAL TelemetryPipelineService, at
 * the profile's target rate, for the (possibly overridden) duration,
 * recording per-segment latency via the pipeline's onStage hook. This
 * calls the SAME pipeline.process() every real telemetry request goes
 * through — no framework-adapter translation step is exercised (the load
 * test already produces canonical-shaped events directly), matching how
 * WO-044's own AC frames this as pipeline load, not adapter load.
 */
export async function runLoadTest(
  pipeline: TelemetryPipelineService,
  pool: SyntheticTenantAgent[][],
  profile: LoadTestProfile,
  options: RunLoadTestOptions = {},
): Promise<{ report: LoadTestReport; collector: LatencyCollector }> {
  const durationSeconds = options.durationSecondsOverride ?? profile.durationSeconds;
  const flatPool = pool.flat();
  const collector = new LatencyCollector();

  const startedAt = new Date().toISOString();
  let eventCount = 0;
  let errorCount = 0;
  let deadLetteredCount = 0;
  let quarantinedCount = 0;

  const intervalMs = 1000 / profile.eventsPerSecond;
  const totalEvents = Math.max(1, Math.round(profile.eventsPerSecond * durationSeconds));

  const inFlight: Promise<void>[] = [];
  for (let i = 0; i < totalEvents; i++) {
    const event = generateSyntheticEvent(flatPool, profile);
    const task = pipeline
      .process(undefined, event, (stage, elapsedMs) => collector.record(stage, elapsedMs))
      .then((result) => {
        eventCount++;
        if (result.deadLettered) deadLetteredCount++;
        if (result.quarantined) quarantinedCount++;
      })
      .catch(() => {
        errorCount++;
      });
    inFlight.push(task);

    if (i < totalEvents - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  await Promise.all(inFlight);

  const finishedAt = new Date().toISOString();

  const report: LoadTestReport = {
    profile: profile.name,
    eventsPerSecondTarget: profile.eventsPerSecond,
    durationSeconds,
    startedAt,
    finishedAt,
    eventCount,
    errorCount,
    deadLetteredCount,
    quarantinedCount,
    segments: collector.stats(),
    notVerifiableInThisEnvironment: [
      "Kafka publish -> consumer receipt (no reachable broker or consumer group in this sandbox)",
      "WebSocket push -> dashboard render (no frontend client exists in this repo)",
      "Consumer lag alerting (no Kafka consumer group exists to lag at all)",
    ],
  };

  return { report, collector };
}
