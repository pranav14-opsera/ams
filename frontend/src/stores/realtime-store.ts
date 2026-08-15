import { create } from "zustand";
import type { ConnectionState } from "@/types/websocket";

export interface RealtimeState {
  connectionState: ConnectionState;
  subscriptions: Set<string>;
  reconnectAttempts: number;
  lastConnectedAt: string | null;
  /** Latest batched payload delivered per channel — the single source of truth components read from (useRealtimeUpdates writes here; nothing else should). */
  latestByChannel: Map<string, unknown>;
  setConnectionState: (state: ConnectionState) => void;
  setReconnectAttempts: (count: number) => void;
  addSubscription: (channel: string) => void;
  removeSubscription: (channel: string) => void;
  setLatest: (channel: string, payload: unknown) => void;
}

export const useRealtimeStore = create<RealtimeState>((set) => ({
  connectionState: "connecting",
  subscriptions: new Set(),
  reconnectAttempts: 0,
  lastConnectedAt: null,
  latestByChannel: new Map(),

  setConnectionState: (connectionState) =>
    set((state) => ({
      connectionState,
      lastConnectedAt: connectionState === "connected" ? new Date().toISOString() : state.lastConnectedAt,
    })),

  setReconnectAttempts: (reconnectAttempts) => set({ reconnectAttempts }),

  addSubscription: (channel) =>
    set((state) => {
      const next = new Set(state.subscriptions);
      next.add(channel);
      return { subscriptions: next };
    }),

  removeSubscription: (channel) =>
    set((state) => {
      const next = new Set(state.subscriptions);
      next.delete(channel);
      return { subscriptions: next };
    }),

  setLatest: (channel, payload) =>
    set((state) => {
      const next = new Map(state.latestByChannel);
      next.set(channel, payload);
      return { latestByChannel: next };
    }),
}));
