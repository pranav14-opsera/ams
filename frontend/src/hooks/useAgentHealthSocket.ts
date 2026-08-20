"use client";

import { useCallback, useState } from "react";
import { useRealtimeUpdates } from "@/hooks/useRealtimeUpdates";
import type { AgentStatusUpdateMessage, AgentLifecycleStatus } from "@/types/dashboard";
import type { ConnectionState } from "@/types/websocket";

export interface AgentStatusUpdate {
  status: AgentLifecycleStatus;
  lastSeen: string;
}

export interface UseAgentHealthSocketResult {
  connectionState: ConnectionState;
  /** agentId -> the most recent real-time status update received for it. Every entry that has ever arrived this session, not just the latest single message — a row's own state should only change when a message for THAT row arrives, unlike useHealthWebSocket's single "latest snapshot" model. */
  statusUpdates: Map<string, AgentStatusUpdate>;
}

function isAgentStatusUpdate(payload: unknown): payload is AgentStatusUpdateMessage {
  return typeof payload === "object" && payload !== null && (payload as { type?: unknown }).type === "agent_status_update";
}

/**
 * AC: "Real-time status updates arrive via WebSocket channel /ws/health and
 * update the corresponding agent row within 5 seconds... without a full
 * page reload." Reuses the existing /ws/health channel plumbing
 * (useRealtimeUpdates, same as the WO-057/058 health dashboard's own
 * useHealthWebSocket) rather than a new gateway/channel — HealthGateway
 * already fans out both HealthMetricsPublisherService's fleet-health
 * snapshots (untagged) and LifecycleService's own `agent_status_update`
 * messages (shape-tagged) on this one channel; this hook only reacts to
 * the latter, keyed by agentId, and simply ignores every other message
 * shape.
 *
 * Known limitation, inherited from useRealtimeUpdates' shared 100ms-batch
 * "latest of the batch" delivery model (the same one useHealthWebSocket
 * itself has): if two DIFFERENT agents' status_update messages land in the
 * same 100ms batching window, only the later one in that window reaches
 * this hook's onUpdate callback — the other is superseded before it's ever
 * observed here. A per-agent-keyed batch delivery API would need a change
 * to useWebSocketBatcher/useRealtimeUpdates themselves (shared
 * infrastructure well outside this one page's scope) to fix; documented
 * here rather than silently accepted.
 */
export function useAgentHealthSocket(): UseAgentHealthSocketResult {
  const [statusUpdates, setStatusUpdates] = useState<Map<string, AgentStatusUpdate>>(new Map());

  const onUpdate = useCallback((payload: unknown) => {
    if (!isAgentStatusUpdate(payload)) return;
    setStatusUpdates((prev) => {
      const next = new Map(prev);
      next.set(payload.agentId, { status: payload.status, lastSeen: payload.lastSeen });
      return next;
    });
  }, []);

  const { connectionState } = useRealtimeUpdates<unknown>("health", onUpdate);

  return { connectionState, statusUpdates };
}
