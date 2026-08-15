"use client";

import * as Comlink from "comlink";
import { useEffect, useRef } from "react";
import { sortBySeverity } from "@/lib/agent-health";
import type { HealthMetricsWorkerApi } from "@/workers/health-metrics-worker";
import type { AgentHealthViewModel, FleetHealthSummary } from "@/types/dashboard";

function computeFleetSummaryMainThread(agents: AgentHealthViewModel[]): FleetHealthSummary {
  if (agents.length === 0) return { totalAgents: 0, activePct: 0, degradedPct: 0, errorPct: 0, pausedPct: 0, retiredPct: 0 };
  const counts = { active: 0, degraded: 0, error: 0, paused: 0, retired: 0 };
  for (const agent of agents) counts[agent.status]++;
  const pct = (n: number) => Math.round((n / agents.length) * 1000) / 10;
  return { totalAgents: agents.length, activePct: pct(counts.active), degradedPct: pct(counts.degraded), errorPct: pct(counts.error), pausedPct: pct(counts.paused), retiredPct: pct(counts.retired) };
}

export interface HealthMetricsComputer {
  computeFleetSummary(agents: AgentHealthViewModel[]): Promise<FleetHealthSummary>;
  sortBySeverity(agents: AgentHealthViewModel[]): Promise<AgentHealthViewModel[]>;
}

/**
 * Instantiates the health-metrics Web Worker via Comlink for type-safe
 * postMessage communication; falls back to synchronous main-thread
 * computation (the exact same logic, just not off-thread) if Worker
 * construction throws — jsdom/SSR/very old browsers, or any environment
 * where `Worker` isn't available. The fallback keeps the dashboard
 * functional rather than crashing when offloading isn't possible.
 */
export function useHealthMetricsWorker(): HealthMetricsComputer {
  const apiRef = useRef<Comlink.Remote<HealthMetricsWorkerApi> | null>(null);
  const workerRef = useRef<Worker | null>(null);

  useEffect(() => {
    if (typeof Worker === "undefined") return;
    try {
      const worker = new Worker(new URL("../workers/health-metrics-worker.ts", import.meta.url), { type: "module" });
      workerRef.current = worker;
      apiRef.current = Comlink.wrap<HealthMetricsWorkerApi>(worker);
    } catch {
      apiRef.current = null;
    }

    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
      apiRef.current = null;
    };
  }, []);

  return {
    async computeFleetSummary(agents) {
      if (apiRef.current) {
        try {
          return await apiRef.current.computeFleetSummary(agents);
        } catch {
          // fall through to main-thread computation
        }
      }
      return computeFleetSummaryMainThread(agents);
    },
    async sortBySeverity(agents) {
      if (apiRef.current) {
        try {
          return await apiRef.current.sortBySeverity(agents);
        } catch {
          // fall through to main-thread computation
        }
      }
      return sortBySeverity(agents);
    },
  };
}
