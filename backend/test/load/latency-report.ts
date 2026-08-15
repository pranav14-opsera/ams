import { writeFileSync } from "node:fs";
import type { SegmentStats } from "./latency-stats";

export interface LoadTestReport {
  profile: string;
  eventsPerSecondTarget: number;
  durationSeconds: number;
  startedAt: string;
  finishedAt: string;
  eventCount: number;
  errorCount: number;
  deadLetteredCount: number;
  quarantinedCount: number;
  segments: Record<string, SegmentStats>;
  notVerifiableInThisEnvironment: string[];
}

export function writeReport(path: string, report: LoadTestReport): void {
  writeFileSync(path, JSON.stringify(report, null, 2));
}
